// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isNumber } from 'lodash';
import type { Readable, Writable } from 'stream';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { ensureFile } from 'fs-extra';

import { createLogger } from '../logging/log';
import * as Errors from '../types/errors';
import { strictAssert } from '../util/assert';
import {
  AttachmentSizeError,
  type AttachmentType,
  AttachmentVariant,
  AttachmentPermanentlyUndownloadableError,
  hasRequiredInformationForBackup,
  type BackupableAttachmentType,
} from '../types/Attachment';
import * as Bytes from '../Bytes';
import {
  getAttachmentCiphertextLength,
  safeUnlink,
  splitKeys,
  type ReencryptedAttachmentV2,
  decryptAndReencryptLocally,
  measureSize,
  type IntegrityCheckType,
} from '../AttachmentCrypto';
import type { ProcessedAttachment } from './Types.d';
import type { WebAPIType } from './WebAPI';
import { createName, getRelativePath } from '../util/attachmentPath';
import { MediaTier } from '../types/AttachmentDownload';
import {
  getBackupMediaRootKey,
  deriveBackupMediaKeyMaterial,
  type BackupMediaKeyMaterialType,
} from '../services/backups/crypto';
import { backupsService } from '../services/backups';
import {
  getMediaIdForAttachment,
  getMediaIdForAttachmentThumbnail,
} from '../services/backups/util/mediaId';
import { MAX_BACKUP_THUMBNAIL_SIZE } from '../types/VisualAttachment';
import { missingCaseError } from '../util/missingCaseError';
import { IV_LENGTH, MAC_LENGTH } from '../types/Crypto';
import { BackupCredentialType } from '../types/backups';
import { getValue } from '../RemoteConfig';
import { parseIntOrThrow } from '../util/parseIntOrThrow';

const log = createLogger('downloadAttachment');

export function getCdnKey(attachment: ProcessedAttachment): string {
  const cdnKey = attachment.cdnId || attachment.cdnKey;
  strictAssert(cdnKey, 'Attachment was missing cdnId or cdnKey');
  return cdnKey;
}

export function getBackupMediaOuterEncryptionKeyMaterial(
  attachment: BackupableAttachmentType
): BackupMediaKeyMaterialType {
  const mediaId = getMediaIdForAttachment(attachment);
  const backupKey = getBackupMediaRootKey();
  return deriveBackupMediaKeyMaterial(backupKey, mediaId.bytes);
}

function getBackupThumbnailInnerEncryptionKeyMaterial(
  attachment: BackupableAttachmentType
): BackupMediaKeyMaterialType {
  const mediaId = getMediaIdForAttachmentThumbnail(attachment);
  const backupKey = getBackupMediaRootKey();
  return deriveBackupMediaKeyMaterial(backupKey, mediaId.bytes);
}
function getBackupThumbnailOuterEncryptionKeyMaterial(
  attachment: BackupableAttachmentType
): BackupMediaKeyMaterialType {
  const mediaId = getMediaIdForAttachmentThumbnail(attachment);
  const backupKey = getBackupMediaRootKey();
  return deriveBackupMediaKeyMaterial(backupKey, mediaId.bytes);
}

export async function getCdnNumberForBackupTier(
  attachment: BackupableAttachmentType
): Promise<number> {
  let { backupCdnNumber } = attachment;

  if (backupCdnNumber == null) {
    const mediaId = getMediaIdForAttachment(attachment);
    const backupCdnInfo = await backupsService.getBackupCdnInfo(mediaId.string);
    if (backupCdnInfo.isInBackupTier) {
      backupCdnNumber = backupCdnInfo.cdnNumber;
    } else {
      backupCdnNumber = parseIntOrThrow(
        getValue('global.backups.mediaTierFallbackCdnNumber'),
        'global.backups.mediaTierFallbackCdnNumber must be set'
      );
    }
  }
  return backupCdnNumber;
}

export async function downloadAttachment(
  server: WebAPIType,
  {
    attachment,
    mediaTier,
  }:
    | { attachment: AttachmentType; mediaTier: MediaTier.STANDARD }
    | { attachment: BackupableAttachmentType; mediaTier: MediaTier.BACKUP },
  options: {
    disableRetries?: boolean;
    logPrefix?: string;
    onSizeUpdate: (totalBytes: number) => void;
    timeout?: number;
    variant: AttachmentVariant;
    abortSignal: AbortSignal;
  }
): Promise<ReencryptedAttachmentV2> {
  const logId = `downloadAttachment/${options.logPrefix ?? ''}`;

  const { digest, plaintextHash, incrementalMac, chunkSize, key, size } =
    attachment;

  try {
    strictAssert(
      digest || plaintextHash,
      `${logId}: missing digest and plaintextHash`
    );
    strictAssert(key, `${logId}: missing key`);
    strictAssert(isNumber(size), `${logId}: missing size`);
  } catch (error) {
    throw new AttachmentPermanentlyUndownloadableError(error.message);
  }

  let downloadResult: Awaited<ReturnType<typeof downloadToDisk>>;

  let { downloadPath } = attachment;
  const absoluteDownloadPath = downloadPath
    ? window.Signal.Migrations.getAbsoluteDownloadsPath(downloadPath)
    : undefined;
  let downloadOffset = 0;

  if (absoluteDownloadPath) {
    try {
      ({ size: downloadOffset } = await stat(absoluteDownloadPath));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.error(
          'Failed to get file size for previous download',
          Errors.toLogFormat(error)
        );
        try {
          await safeUnlink(absoluteDownloadPath);
        } catch {
          downloadPath = undefined;
        }
      }
    }
  }

  // Start over if we go over the size
  if (downloadOffset >= size && absoluteDownloadPath) {
    log.warn('went over, retrying');
    await safeUnlink(absoluteDownloadPath);
    downloadOffset = 0;
  }

  if (downloadOffset !== 0) {
    log.info(`${logId}: resuming from ${downloadOffset}`);
  }
  if (mediaTier === MediaTier.BACKUP) {
    strictAssert(
      hasRequiredInformationForBackup(attachment),
      `${logId}: attachment missing critical information for backup tier`
    );
  }

  if (mediaTier === MediaTier.STANDARD) {
    strictAssert(
      options.variant !== AttachmentVariant.ThumbnailFromBackup,
      'Thumbnails can only be downloaded from backup tier'
    );
    const cdnKey = getCdnKey(attachment);
    const { cdnNumber } = attachment;

    const downloadStream = await server.getAttachment({
      cdnKey,
      cdnNumber,
      options: {
        ...options,
        downloadOffset,
      },
    });
    log.info(
      `${logId}: calling downloadToDisk with ${downloadPath ? '' : 'no '}downloadPath`
    );
    downloadResult = await downloadToDisk({
      downloadOffset,
      downloadPath,
      downloadStream,
      onSizeUpdate: options.onSizeUpdate,
      size,
    });
  } else {
    strictAssert(mediaTier === MediaTier.BACKUP, 'backup media tier');

    const mediaId =
      options.variant === AttachmentVariant.ThumbnailFromBackup
        ? getMediaIdForAttachmentThumbnail(attachment)
        : getMediaIdForAttachment(attachment);

    const cdnNumber = await getCdnNumberForBackupTier(attachment);
    const cdnCredentials =
      await backupsService.credentials.getCDNReadCredentials(
        cdnNumber,
        BackupCredentialType.Media
      );

    const backupDir = await backupsService.api.getBackupDir();
    const mediaDir = await backupsService.api.getMediaDir();

    const downloadStream = await server.getAttachmentFromBackupTier({
      mediaId: mediaId.string,
      backupDir,
      mediaDir,
      headers: cdnCredentials.headers,
      cdnNumber,
      options: {
        ...options,
        downloadOffset,
      },
    });
    downloadResult = await downloadToDisk({
      downloadStream,
      downloadPath,
      downloadOffset,
      onSizeUpdate: options.onSizeUpdate,
      size: getAttachmentCiphertextLength(
        options.variant === AttachmentVariant.ThumbnailFromBackup
          ? // be generous, accept downloads of up to twice what we expect for thumbnail
            MAX_BACKUP_THUMBNAIL_SIZE * 2
          : size
      ),
    });
  }

  const { absolutePath: cipherTextAbsolutePath, downloadSize } = downloadResult;

  try {
    switch (options.variant) {
      case AttachmentVariant.Default:
      case undefined: {
        const { aesKey, macKey } = splitKeys(Bytes.fromBase64(key));
        let integrityCheck: IntegrityCheckType;
        if (plaintextHash) {
          integrityCheck = {
            type: 'plaintext',
            plaintextHash: Bytes.fromHex(plaintextHash),
          };
        } else if (digest) {
          integrityCheck = {
            type: 'encrypted',
            digest: Bytes.fromBase64(digest),
          };
        } else {
          throw new Error(`${logId}: missing both digest and plaintextHash`);
        }

        return await decryptAndReencryptLocally({
          type: 'standard',
          ciphertextPath: cipherTextAbsolutePath,
          idForLogging: logId,
          aesKey,
          macKey,
          size,
          integrityCheck,
          theirIncrementalMac: incrementalMac
            ? Bytes.fromBase64(incrementalMac)
            : undefined,
          theirChunkSize: chunkSize,
          outerEncryption:
            mediaTier === 'backup'
              ? getBackupMediaOuterEncryptionKeyMaterial(attachment)
              : undefined,
          getAbsoluteAttachmentPath:
            window.Signal.Migrations.getAbsoluteAttachmentPath,
        });
      }
      case AttachmentVariant.ThumbnailFromBackup: {
        strictAssert(
          mediaTier === 'backup',
          'Thumbnail must be downloaded from backup tier'
        );
        const thumbnailEncryptionKeys =
          getBackupThumbnailInnerEncryptionKeyMaterial(attachment);
        // backup thumbnails don't get trimmed, so we just calculate the size as the
        // ciphertextSize, less IV and MAC
        const calculatedSize = downloadSize - IV_LENGTH - MAC_LENGTH;
        return decryptAndReencryptLocally({
          type: 'backupThumbnail',
          ciphertextPath: cipherTextAbsolutePath,
          idForLogging: logId,
          size: calculatedSize,
          ...thumbnailEncryptionKeys,
          outerEncryption:
            getBackupThumbnailOuterEncryptionKeyMaterial(attachment),
          getAbsoluteAttachmentPath:
            window.Signal.Migrations.getAbsoluteAttachmentPath,
        });
      }
      default: {
        throw missingCaseError(options.variant);
      }
    }
  } finally {
    if (!downloadPath) {
      await safeUnlink(cipherTextAbsolutePath);
    }
  }
}

async function downloadToDisk({
  downloadOffset = 0,
  downloadPath,
  downloadStream,
  onSizeUpdate,
  size,
}: {
  downloadOffset?: number;
  downloadPath?: string;
  downloadStream: Readable;
  onSizeUpdate: (totalBytes: number) => void;
  size: number;
}): Promise<{ absolutePath: string; downloadSize: number }> {
  const absoluteTargetPath = downloadPath
    ? window.Signal.Migrations.getAbsoluteDownloadsPath(downloadPath)
    : window.Signal.Migrations.getAbsoluteAttachmentPath(
        getRelativePath(createName())
      );
  await ensureFile(absoluteTargetPath);
  let writeStream: Writable;
  if (downloadPath) {
    writeStream = createWriteStream(absoluteTargetPath, {
      flags: 'a',
      start: downloadOffset,
    });
  } else {
    strictAssert(
      !downloadOffset,
      'Download cannot be resumed without downloadPath'
    );
    writeStream = createWriteStream(absoluteTargetPath);
  }

  const targetSize = getAttachmentCiphertextLength(size) - downloadOffset;
  let downloadSize = 0;

  try {
    await pipeline(
      downloadStream,
      checkSize(targetSize),
      measureSize({
        downloadOffset,
        onSizeUpdate,
        onComplete: bytesSeen => {
          downloadSize = bytesSeen;
        },
      }),
      writeStream
    );
  } catch (error) {
    if (downloadPath) {
      log.warn(`downloadToDisk: stopping at ${downloadSize}`);
    } else {
      try {
        await safeUnlink(absoluteTargetPath);
      } catch (cleanupError) {
        log.error(
          'downloadToDisk: Error while cleaning up',
          Errors.toLogFormat(cleanupError)
        );
      }
    }

    throw error;
  }

  return { absolutePath: absoluteTargetPath, downloadSize };
}

// A simple transform that throws if it sees more than maxBytes on the stream.
function checkSize(expectedBytes: number) {
  let totalBytes = 0;

  // TODO (DESKTOP-7046): remove size buffer
  const maximumSizeBeforeError = expectedBytes * 1.05;
  return new Transform({
    transform(chunk, encoding, callback) {
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumSizeBeforeError) {
        callback(
          new AttachmentSizeError(
            `checkSize: Received ${totalBytes} bytes, max is ${maximumSizeBeforeError}`
          )
        );
        return;
      }

      if (totalBytes > expectedBytes) {
        log.warn(
          `checkSize: Received ${totalBytes} bytes, expected ${expectedBytes}`
        );
      }

      this.push(chunk, encoding);
      callback();
    },
  });
}
