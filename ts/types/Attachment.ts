// Copyright 2018 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-classes-per-file */

import moment from 'moment';
import {
  isNumber,
  padStart,
  isFunction,
  isUndefined,
  isString,
  omit,
  partition,
} from 'lodash';
import { blobToArrayBuffer } from 'blob-util';

import type { LinkPreviewForUIType } from './message/LinkPreviews';
import type { LoggerType } from './Logging';
import { createLogger } from '../logging/log';
import * as MIME from './MIME';
import { toLogFormat } from './errors';
import { SignalService } from '../protobuf';
import {
  isImageTypeSupported,
  isVideoTypeSupported,
} from '../util/GoogleChrome';
import type {
  LocalizerType,
  WithOptionalProperties,
  WithRequiredProperties,
} from './Util';
import { ThemeType } from './Util';
import * as GoogleChrome from '../util/GoogleChrome';
import { ReadStatus } from '../messages/MessageReadStatus';
import type { MessageStatusType } from '../components/conversation/Message';
import type { SignalService as Proto } from '../protobuf';
import { isMoreRecentThan } from '../util/timestamp';
import { DAY } from '../util/durations';
import { getMessageQueueTime } from '../util/getMessageQueueTime';
import { getLocalAttachmentUrl } from '../util/getLocalAttachmentUrl';
import {
  isValidAttachmentKey,
  isValidDigest,
  isValidPlaintextHash,
} from './Crypto';
import { redactGenericText } from '../util/privacy';
import { missingCaseError } from '../util/missingCaseError';

const logging = createLogger('Attachment');

const MAX_TIMELINE_IMAGE_WIDTH = 300;
const MAX_TIMELINE_IMAGE_HEIGHT = MAX_TIMELINE_IMAGE_WIDTH * 1.5;
const MIN_TIMELINE_IMAGE_WIDTH = 200;
const MIN_TIMELINE_IMAGE_HEIGHT = 50;

const MAX_DISPLAYABLE_IMAGE_WIDTH = 8192;
const MAX_DISPLAYABLE_IMAGE_HEIGHT = 8192;
// Used for display

export class AttachmentSizeError extends Error {}

// Used for downlaods

export class AttachmentPermanentlyUndownloadableError extends Error {
  constructor(message: string) {
    super(`AttachmentPermanentlyUndownloadableError: ${message}`);
  }
}

export type ThumbnailType = EphemeralAttachmentFields & {
  size: number;
  contentType: MIME.MIMEType;
  path?: string;
  plaintextHash?: string;
  width?: number;
  height?: number;
  version?: 1 | 2;
  localKey?: string; // AES + MAC
};

export type ScreenshotType = WithOptionalProperties<ThumbnailType, 'size'>;
export type BackupThumbnailType = WithOptionalProperties<ThumbnailType, 'size'>;

// These fields do not get saved to the DB.
export type EphemeralAttachmentFields = {
  totalDownloaded?: number;
  data?: Uint8Array;
  /** Not included in protobuf, needs to be pulled from flags */
  isVoiceMessage?: boolean;
  /** For messages not already on disk, this will be a data url */
  url?: string;
  screenshotData?: Uint8Array;
  /** @deprecated Legacy field */
  screenshotPath?: string;

  /** @deprecated Legacy field. Used only for downloading old attachment */
  id?: number;
  /** @deprecated Legacy field, used long ago for migrating attachments to disk. */
  schemaVersion?: number;
  /** @deprecated Legacy field, replaced by cdnKey */
  cdnId?: string;
  /** @deprecated Legacy fields, no longer needed */
  iv?: never;
  isReencryptableToSameDigest?: never;
  reencryptionInfo?: never;
};

/**
 * Adding a field to AttachmentType requires:
 * 1) adding a column to message_attachments
 * 2) updating MessageAttachmentDBReferenceType and MESSAGE_ATTACHMENT_COLUMNS
 * 3) saving data to the proper column
 */
export type AttachmentType = EphemeralAttachmentFields & {
  error?: boolean;
  blurHash?: string;
  caption?: string;
  clientUuid?: string;
  contentType: MIME.MIMEType;
  digest?: string;
  fileName?: string;
  plaintextHash?: string;
  uploadTimestamp?: number;
  size: number;
  pending?: boolean;
  width?: number;
  height?: number;
  path?: string;
  screenshot?: ScreenshotType;
  flags?: number;
  thumbnail?: ThumbnailType;
  isCorrupted?: boolean;
  cdnNumber?: number;
  cdnKey?: string;
  downloadPath?: string;
  key?: string;

  textAttachment?: TextAttachmentType;
  wasTooBig?: boolean;

  // If `true` backfill is unavailable
  backfillError?: boolean;

  incrementalMac?: string;
  chunkSize?: number;
  backupCdnNumber?: number;
  localBackupPath?: string;

  // See app/attachment_channel.ts
  version?: 1 | 2;
  localKey?: string; // AES + MAC
  thumbnailFromBackup?: BackupThumbnailType;

  /** For quote attachments, if copied from the referenced attachment */
  copied?: boolean;
};

export type LocalAttachmentV2Type = Readonly<{
  version: 2;
  path: string;
  localKey: string;
  plaintextHash: string;
  size: number;
}>;

export type AddressableAttachmentType = Readonly<{
  version?: 1 | 2;
  path: string;
  localKey?: string;
  size?: number;
  contentType: MIME.MIMEType;

  // In-memory data, for outgoing attachments that are not saved to disk.
  data?: Uint8Array;
}>;

export type AttachmentForUIType = AttachmentType & {
  isPermanentlyUndownloadable: boolean;
  thumbnailFromBackup?: {
    url?: string;
  };
};

export type UploadedAttachmentType = Proto.IAttachmentPointer &
  Readonly<{
    // Required fields
    cdnKey: string;
    iv: Uint8Array;
    key: Uint8Array;
    size: number;
    digest: Uint8Array;
    contentType: string;
    plaintextHash: string;
    isReencryptableToSameDigest: true;
  }>;

export type AttachmentWithHydratedData = AttachmentType & {
  data: Uint8Array;
};

export enum TextAttachmentStyleType {
  DEFAULT = 0,
  REGULAR = 1,
  BOLD = 2,
  SERIF = 3,
  SCRIPT = 4,
  CONDENSED = 5,
}

export type TextAttachmentType = {
  text?: string | null;
  textStyle?: number | null;
  textForegroundColor?: number | null;
  textBackgroundColor?: number | null;
  preview?: LinkPreviewForUIType;
  gradient?: {
    startColor?: number | null;
    endColor?: number | null;
    angle?: number | null;
    colors?: ReadonlyArray<number> | null;
    positions?: ReadonlyArray<number> | null;
  } | null;
  color?: number | null;
};

export type BaseAttachmentDraftType = {
  blurHash?: string;
  contentType: MIME.MIMEType;
  screenshotContentType?: MIME.MIMEType;
  size: number;
  flags?: number;
};

// An ephemeral attachment type, used between user's request to add the attachment as
//   a draft and final save on disk and in conversation.draftAttachments.
export type InMemoryAttachmentDraftType =
  | ({
      data: Uint8Array;
      clientUuid: string;
      pending: false;
      screenshotData?: Uint8Array;
      fileName?: string;
      path?: string;
    } & BaseAttachmentDraftType)
  | {
      contentType: MIME.MIMEType;
      clientUuid: string;
      fileName?: string;
      path?: string;
      pending: true;
      size: number;
    };

// What's stored in conversation.draftAttachments
export type AttachmentDraftType =
  | ({
      url?: string;
      screenshot?: ScreenshotType;
      // Legacy field
      screenshotPath?: string;
      pending: false;
      // Old draft attachments may have a caption, though they are no longer editable
      //   because we removed the caption editor.
      caption?: string;
      fileName?: string;
      path: string;
      width?: number;
      height?: number;
      clientUuid: string;
      version?: 2;
      localKey?: string;
    } & BaseAttachmentDraftType)
  | {
      clientUuid: string;
      contentType: MIME.MIMEType;
      fileName?: string;
      path?: string;
      pending: true;
      size: number;
    };

export enum AttachmentVariant {
  Default = 'Default',
  ThumbnailFromBackup = 'thumbnailFromBackup',
}

// // Incoming message attachment fields
// {
//   id: string
//   contentType: MIMEType
//   data: Uint8Array
//   digest: Uint8Array
//   fileName?: string
//   flags: null
//   key: Uint8Array
//   size: integer
//   thumbnail: Uint8Array
// }

// // Outgoing message attachment fields
// {
//   contentType: MIMEType
//   data: Uint8Array
//   fileName: string
//   size: integer
// }

// Returns true if `rawAttachment` is a valid attachment based on our current schema.
// Over time, we can expand this definition to become more narrow, e.g. require certain
// fields, etc.
export function isValid(
  rawAttachment?: Pick<AttachmentType, 'data' | 'path'>
): rawAttachment is AttachmentType {
  // NOTE: We cannot use `_.isPlainObject` because `rawAttachment` is
  // deserialized by protobuf:
  if (!rawAttachment) {
    return false;
  }

  return true;
}

const UNICODE_LEFT_TO_RIGHT_OVERRIDE = '\u202D';
const UNICODE_RIGHT_TO_LEFT_OVERRIDE = '\u202E';
const UNICODE_REPLACEMENT_CHARACTER = '\uFFFD';
const INVALID_CHARACTERS_PATTERN = new RegExp(
  `[${UNICODE_LEFT_TO_RIGHT_OVERRIDE}${UNICODE_RIGHT_TO_LEFT_OVERRIDE}]`,
  'g'
);

// NOTE: Expose synchronous version to do property-based testing using `testcheck`,
// which currently doesn’t support async testing:
// https://github.com/leebyron/testcheck-js/issues/45
export function _replaceUnicodeOrderOverridesSync(
  attachment: AttachmentType
): AttachmentType {
  if (!isString(attachment.fileName)) {
    return attachment;
  }

  const normalizedFilename = attachment.fileName.replace(
    INVALID_CHARACTERS_PATTERN,
    UNICODE_REPLACEMENT_CHARACTER
  );
  const newAttachment = { ...attachment, fileName: normalizedFilename };

  return newAttachment;
}

export const replaceUnicodeOrderOverrides = async (
  attachment: AttachmentType
): Promise<AttachmentType> => {
  return _replaceUnicodeOrderOverridesSync(attachment);
};

// \u202A-\u202E is LRE, RLE, PDF, LRO, RLO
// \u2066-\u2069 is LRI, RLI, FSI, PDI
// \u200E is LRM
// \u200F is RLM
// \u061C is ALM
const V2_UNWANTED_UNICODE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

export async function replaceUnicodeV2(
  attachment: AttachmentType
): Promise<AttachmentType> {
  if (!isString(attachment.fileName)) {
    return attachment;
  }

  const fileName = attachment.fileName.replace(
    V2_UNWANTED_UNICODE,
    UNICODE_REPLACEMENT_CHARACTER
  );

  return {
    ...attachment,
    fileName,
  };
}

export function removeSchemaVersion({
  attachment,
  logger,
}: {
  attachment: AttachmentType;
  logger: LoggerType;
}): AttachmentType {
  if (!isValid(attachment)) {
    logger.error(
      'Attachment.removeSchemaVersion: Invalid input attachment:',
      attachment
    );
    return attachment;
  }

  return omit(attachment, 'schemaVersion');
}

export function hasData(attachment: AttachmentType): boolean {
  return attachment.data instanceof Uint8Array;
}

export function loadData(
  readAttachmentV2Data: (
    attachment: Partial<AddressableAttachmentType>
  ) => Promise<Uint8Array>
): (
  attachment: Partial<AttachmentType>
) => Promise<AttachmentWithHydratedData> {
  if (!isFunction(readAttachmentV2Data)) {
    throw new TypeError("'readAttachmentData' must be a function");
  }

  return async attachment => {
    if (!isValid(attachment)) {
      throw new TypeError("'attachment' is not valid");
    }

    const isAlreadyLoaded = Boolean(attachment.data);
    if (isAlreadyLoaded) {
      return attachment as AttachmentWithHydratedData;
    }

    if (!isString(attachment.path)) {
      throw new TypeError("'attachment.path' is required");
    }

    const data = await readAttachmentV2Data(attachment);
    return { ...attachment, data, size: data.byteLength };
  };
}

export function deleteData({
  deleteOnDisk,
  deleteDownloadOnDisk,
}: {
  deleteOnDisk: (path: string) => Promise<void>;
  deleteDownloadOnDisk: (path: string) => Promise<void>;
}): (attachment?: AttachmentType) => Promise<void> {
  if (!isFunction(deleteOnDisk)) {
    throw new TypeError('deleteData: deleteOnDisk must be a function');
  }

  return async (attachment?: AttachmentType): Promise<void> => {
    if (!isValid(attachment)) {
      throw new TypeError('deleteData: attachment is not valid');
    }

    const { path, downloadPath, thumbnail, screenshot, thumbnailFromBackup } =
      attachment;

    if (isString(path)) {
      await deleteOnDisk(path);
    }

    if (isString(downloadPath)) {
      await deleteDownloadOnDisk(downloadPath);
    }

    if (thumbnail && isString(thumbnail.path)) {
      await deleteOnDisk(thumbnail.path);
    }

    if (screenshot && isString(screenshot.path)) {
      await deleteOnDisk(screenshot.path);
    }

    if (thumbnailFromBackup && isString(thumbnailFromBackup.path)) {
      await deleteOnDisk(thumbnailFromBackup.path);
    }
  };
}

const THUMBNAIL_SIZE = 150;
const THUMBNAIL_CONTENT_TYPE = MIME.IMAGE_PNG;

export async function captureDimensionsAndScreenshot(
  attachment: AttachmentType,
  params: {
    writeNewAttachmentData: (
      data: Uint8Array
    ) => Promise<LocalAttachmentV2Type>;
    makeObjectUrl: (
      data: Uint8Array | ArrayBuffer,
      contentType: MIME.MIMEType
    ) => string;
    revokeObjectUrl: (path: string) => void;
    getImageDimensions: (params: {
      objectUrl: string;
      logger: LoggerType;
    }) => Promise<{
      width: number;
      height: number;
    }>;
    makeImageThumbnail: (params: {
      size: number;
      objectUrl: string;
      contentType: MIME.MIMEType;
      logger: LoggerType;
    }) => Promise<Blob>;
    makeVideoScreenshot: (params: {
      objectUrl: string;
      contentType: MIME.MIMEType;
      logger: LoggerType;
    }) => Promise<Blob>;
    logger: LoggerType;
  }
): Promise<AttachmentType> {
  const { contentType } = attachment;

  const {
    writeNewAttachmentData,
    makeObjectUrl,
    revokeObjectUrl,
    getImageDimensions: getImageDimensionsFromURL,
    makeImageThumbnail,
    makeVideoScreenshot,
    logger,
  } = params;

  if (
    !GoogleChrome.isImageTypeSupported(contentType) &&
    !GoogleChrome.isVideoTypeSupported(contentType)
  ) {
    return attachment;
  }

  // If the attachment hasn't been downloaded yet, we won't have a path
  if (!attachment.path) {
    return attachment;
  }

  const localUrl = getLocalAttachmentUrl(attachment);

  if (GoogleChrome.isImageTypeSupported(contentType)) {
    try {
      const { width, height } = await getImageDimensionsFromURL({
        objectUrl: localUrl,
        logger,
      });
      const thumbnailBuffer = await blobToArrayBuffer(
        await makeImageThumbnail({
          size: THUMBNAIL_SIZE,
          objectUrl: localUrl,
          contentType: THUMBNAIL_CONTENT_TYPE,
          logger,
        })
      );

      const thumbnail = await writeNewAttachmentData(
        new Uint8Array(thumbnailBuffer)
      );
      return {
        ...attachment,
        width,
        height,
        thumbnail: {
          ...thumbnail,
          contentType: THUMBNAIL_CONTENT_TYPE,
          width: THUMBNAIL_SIZE,
          height: THUMBNAIL_SIZE,
        },
      };
    } catch (error) {
      logger.error(
        'captureDimensionsAndScreenshot:',
        'error processing image; skipping screenshot generation',
        toLogFormat(error)
      );
      return attachment;
    }
  }

  let screenshotObjectUrl: string | undefined;
  try {
    const screenshotBuffer = await blobToArrayBuffer(
      await makeVideoScreenshot({
        objectUrl: localUrl,
        contentType: THUMBNAIL_CONTENT_TYPE,
        logger,
      })
    );
    screenshotObjectUrl = makeObjectUrl(
      screenshotBuffer,
      THUMBNAIL_CONTENT_TYPE
    );
    const { width, height } = await getImageDimensionsFromURL({
      objectUrl: screenshotObjectUrl,
      logger,
    });
    const screenshot = await writeNewAttachmentData(
      new Uint8Array(screenshotBuffer)
    );

    const thumbnailBuffer = await blobToArrayBuffer(
      await makeImageThumbnail({
        size: THUMBNAIL_SIZE,
        objectUrl: screenshotObjectUrl,
        contentType: THUMBNAIL_CONTENT_TYPE,
        logger,
      })
    );

    const thumbnail = await writeNewAttachmentData(
      new Uint8Array(thumbnailBuffer)
    );

    return {
      ...attachment,
      screenshot: {
        ...screenshot,
        contentType: THUMBNAIL_CONTENT_TYPE,
        width,
        height,
      },
      thumbnail: {
        ...thumbnail,
        contentType: THUMBNAIL_CONTENT_TYPE,
        width: THUMBNAIL_SIZE,
        height: THUMBNAIL_SIZE,
      },
      width,
      height,
    };
  } catch (error) {
    logger.error(
      'captureDimensionsAndScreenshot: error processing video; skipping screenshot generation',
      toLogFormat(error)
    );
    return attachment;
  } finally {
    if (screenshotObjectUrl !== undefined) {
      revokeObjectUrl(screenshotObjectUrl);
    }
  }
}

// UI-focused functions

export function getExtensionForDisplay({
  fileName,
  contentType,
}: {
  fileName?: string;
  contentType: MIME.MIMEType;
}): string | undefined {
  if (fileName && fileName.indexOf('.') >= 0) {
    const lastPeriod = fileName.lastIndexOf('.');
    const extension = fileName.slice(lastPeriod + 1);
    if (extension.length) {
      return extension;
    }
  }

  if (!contentType) {
    return undefined;
  }

  const slash = contentType.indexOf('/');
  if (slash >= 0) {
    return contentType.slice(slash + 1);
  }

  return undefined;
}

export function isAudio(attachments?: ReadonlyArray<AttachmentType>): boolean {
  return Boolean(
    attachments &&
      attachments[0] &&
      attachments[0].contentType &&
      !attachments[0].isCorrupted &&
      MIME.isAudio(attachments[0].contentType)
  );
}

export function isPlayed(
  direction: 'outgoing' | 'incoming',
  status: MessageStatusType | undefined,
  readStatus: ReadStatus | undefined
): boolean {
  if (direction === 'outgoing') {
    return status === 'viewed';
  }
  return readStatus === ReadStatus.Viewed;
}

export function canRenderAudio(
  attachments?: ReadonlyArray<AttachmentType>
): boolean {
  const firstAttachment = attachments && attachments[0];
  if (!firstAttachment) {
    return false;
  }

  return (
    isAudio(attachments) &&
    (isDownloaded(firstAttachment) || isDownloadable(firstAttachment))
  );
}

export function canDisplayImage(
  attachments?: ReadonlyArray<AttachmentType>
): boolean {
  const { height, width } =
    attachments && attachments[0] ? attachments[0] : { height: 0, width: 0 };

  return Boolean(
    height &&
      height > 0 &&
      height <= MAX_DISPLAYABLE_IMAGE_HEIGHT &&
      width &&
      width > 0 &&
      width <= MAX_DISPLAYABLE_IMAGE_WIDTH
  );
}

export function getThumbnailUrl(
  attachment: AttachmentForUIType
): string | undefined {
  if (attachment.thumbnail) {
    return attachment.thumbnail.url;
  }

  return getUrl(attachment);
}

export function getUrl(attachment: AttachmentForUIType): string | undefined {
  if (attachment.screenshot) {
    return attachment.screenshot.url;
  }

  if (isVideoAttachment(attachment)) {
    return undefined;
  }

  return attachment.url ?? attachment.thumbnailFromBackup?.url;
}

export function isImage(attachments?: ReadonlyArray<AttachmentType>): boolean {
  return Boolean(
    attachments &&
      attachments[0] &&
      attachments[0].contentType &&
      isImageTypeSupported(attachments[0].contentType)
  );
}

export function isImageAttachment(
  attachment?: Pick<AttachmentType, 'contentType'>
): boolean {
  return Boolean(
    attachment &&
      attachment.contentType &&
      isImageTypeSupported(attachment.contentType)
  );
}

export function canBeTranscoded(
  attachment?: Pick<AttachmentType, 'contentType'>
): boolean {
  return Boolean(
    attachment &&
      isImageAttachment(attachment) &&
      !MIME.isGif(attachment.contentType)
  );
}

export function hasImage(attachments?: ReadonlyArray<AttachmentType>): boolean {
  return Boolean(
    attachments &&
      attachments[0] &&
      (attachments[0].url || attachments[0].pending || attachments[0].blurHash)
  );
}

export function isVideo(
  attachments?: ReadonlyArray<Pick<AttachmentType, 'contentType'>>
): boolean {
  if (!attachments || attachments.length === 0) {
    return false;
  }
  return isVideoAttachment(attachments[0]);
}

export function isVideoAttachment(
  attachment?: Pick<AttachmentType, 'contentType'>
): boolean {
  if (!attachment || !attachment.contentType) {
    return false;
  }
  return isVideoTypeSupported(attachment.contentType);
}

export function isGIF(attachments?: ReadonlyArray<AttachmentType>): boolean {
  if (!attachments || attachments.length !== 1) {
    return false;
  }

  const [attachment] = attachments;

  const flag = SignalService.AttachmentPointer.Flags.GIF;
  const hasFlag =
    // eslint-disable-next-line no-bitwise
    !isUndefined(attachment.flags) && (attachment.flags & flag) === flag;

  return hasFlag && isVideoAttachment(attachment);
}

function resolveNestedAttachment<
  T extends Pick<AttachmentType, 'textAttachment'>,
>(attachment?: T): T | AttachmentType | undefined {
  if (attachment?.textAttachment?.preview?.image) {
    return attachment.textAttachment.preview.image;
  }
  return attachment;
}

export function isIncremental(
  attachment: Pick<AttachmentForUIType, 'incrementalMac' | 'chunkSize'>
): boolean {
  return Boolean(attachment.incrementalMac && attachment.chunkSize);
}

export function isDownloaded(
  attachment?: Pick<AttachmentType, 'path' | 'textAttachment'>
): boolean {
  const resolved = resolveNestedAttachment(attachment);
  return Boolean(resolved && (resolved.path || resolved.textAttachment));
}

export function isReadyToView(
  attachment?: Pick<
    AttachmentType,
    'incrementalMac' | 'chunkSize' | 'path' | 'textAttachment'
  >
): boolean {
  const fullyDownloaded = isDownloaded(attachment);
  if (fullyDownloaded) {
    return fullyDownloaded;
  }

  const resolved = resolveNestedAttachment(attachment);
  return Boolean(
    resolved &&
      (resolved.path || resolved.textAttachment || isIncremental(resolved))
  );
}

export function hasNotResolved(attachment?: AttachmentType): boolean {
  const resolved = resolveNestedAttachment(attachment);
  return Boolean(resolved && !resolved.url && !resolved.textAttachment);
}

export function isDownloading(attachment?: AttachmentType): boolean {
  const resolved = resolveNestedAttachment(attachment);
  return Boolean(resolved && resolved.pending);
}

export function hasFailed(attachment?: AttachmentType): boolean {
  const resolved = resolveNestedAttachment(attachment);
  return Boolean(resolved && resolved.error);
}

export function hasVideoBlurHash(
  attachments?: ReadonlyArray<AttachmentType>
): boolean {
  const firstAttachment = attachments ? attachments[0] : null;

  return Boolean(firstAttachment && firstAttachment.blurHash);
}

export function hasVideoScreenshot(
  attachments?: ReadonlyArray<AttachmentType>
): string | null | undefined {
  const firstAttachment = attachments ? attachments[0] : null;

  return (
    firstAttachment &&
    firstAttachment.screenshot &&
    firstAttachment.screenshot.url
  );
}

type DimensionsType = {
  height: number;
  width: number;
};

export function getImageDimensionsForTimeline(
  attachment: Pick<AttachmentType, 'width' | 'height'>,
  forcedWidth?: number
): DimensionsType {
  const { height, width } = attachment;
  if (!height || !width) {
    return {
      height: MIN_TIMELINE_IMAGE_HEIGHT,
      width: MIN_TIMELINE_IMAGE_WIDTH,
    };
  }

  const aspectRatio = height / width;
  const targetWidth =
    forcedWidth ||
    Math.max(
      Math.min(MAX_TIMELINE_IMAGE_WIDTH, width),
      MIN_TIMELINE_IMAGE_WIDTH
    );
  const candidateHeight = Math.round(targetWidth * aspectRatio);

  return {
    width: targetWidth,
    height: Math.max(
      Math.min(MAX_TIMELINE_IMAGE_HEIGHT, candidateHeight),
      MIN_TIMELINE_IMAGE_HEIGHT
    ),
  };
}

export function areAllAttachmentsVisual(
  attachments?: ReadonlyArray<AttachmentType>
): boolean {
  if (!attachments) {
    return false;
  }

  const max = attachments.length;
  for (let i = 0; i < max; i += 1) {
    const attachment = attachments[i];
    if (!isImageAttachment(attachment) && !isVideoAttachment(attachment)) {
      return false;
    }
  }

  return true;
}

export function getGridDimensions(
  attachments?: ReadonlyArray<AttachmentType>
): null | DimensionsType {
  if (!attachments || !attachments.length) {
    return null;
  }

  if (!isImage(attachments) && !isVideo(attachments)) {
    return null;
  }

  if (attachments.length === 1) {
    return getImageDimensionsForTimeline(attachments[0]);
  }

  if (attachments.length === 2) {
    // A B
    return {
      height: 150,
      width: 300,
    };
  }

  if (attachments.length === 3) {
    // A A B
    // A A C
    return {
      height: 200,
      width: 300,
    };
  }

  if (attachments.length === 4) {
    // A B
    // C D
    return {
      height: 300,
      width: 300,
    };
  }

  // A A A B B B
  // A A A B B B
  // A A A B B B
  // C C D D E E
  // C C D D E E
  return {
    height: 250,
    width: 300,
  };
}

export function getAlt(
  attachment: AttachmentType,
  i18n: LocalizerType
): string {
  if (isVideoAttachment(attachment)) {
    return i18n('icu:videoAttachmentAlt');
  }
  return i18n('icu:imageAttachmentAlt');
}

// Migration-related attachment stuff

export const isVisualMedia = (attachment: AttachmentType): boolean => {
  const { contentType } = attachment;

  if (isUndefined(contentType)) {
    return false;
  }

  if (isVoiceMessage(attachment)) {
    return false;
  }

  return MIME.isImage(contentType) || MIME.isVideo(contentType);
};

export const isFile = (attachment: AttachmentType): boolean => {
  const { contentType } = attachment;

  if (isUndefined(contentType)) {
    return false;
  }

  if (isVisualMedia(attachment)) {
    return false;
  }

  if (isVoiceMessage(attachment)) {
    return false;
  }

  if (MIME.isLongMessage(contentType)) {
    return false;
  }

  return true;
};

export const isVoiceMessage = (
  attachment: Pick<AttachmentType, 'contentType' | 'fileName' | 'flags'>
): boolean => {
  const flag = SignalService.AttachmentPointer.Flags.VOICE_MESSAGE;
  const hasFlag =
    // eslint-disable-next-line no-bitwise
    !isUndefined(attachment.flags) && (attachment.flags & flag) === flag;
  if (hasFlag) {
    return true;
  }

  const isLegacyAndroidVoiceMessage =
    !isUndefined(attachment.contentType) &&
    MIME.isAudio(attachment.contentType) &&
    !attachment.fileName;
  if (isLegacyAndroidVoiceMessage) {
    return true;
  }

  return false;
};

export const save = async ({
  attachment,
  index,
  getUnusedFilename,
  readAttachmentData,
  saveAttachmentToDisk,
  timestamp,
  baseDir,
}: {
  attachment: AttachmentType;
  index?: number;
  getUnusedFilename: (options: {
    filename: string;
    baseDir?: string;
  }) => string;
  readAttachmentData: (
    attachment: Partial<AddressableAttachmentType>
  ) => Promise<Uint8Array>;
  saveAttachmentToDisk: (options: {
    data: Uint8Array;
    name: string;
    baseDir?: string;
  }) => Promise<{ name: string; fullPath: string } | null>;
  timestamp?: number;
  /**
   * Base directory for saving the attachment.
   * If omitted, a dialog will be opened to let the user choose a directory
   */
  baseDir?: string;
}): Promise<string | null> => {
  let data: Uint8Array;
  if (attachment.path) {
    data = await readAttachmentData(attachment);
  } else if (attachment.data) {
    data = attachment.data;
  } else {
    throw new Error('Attachment had neither path nor data');
  }

  const suggestedFilename = getSuggestedFilename({
    attachment,
    timestamp,
    index,
  });

  /**
   * When baseDir is provided, saveAttachmentToDisk() will save without prompting
   * and may overwrite existing files, so we need to append a suffix
   */
  const name = getUnusedFilename({ filename: suggestedFilename, baseDir });

  const result = await saveAttachmentToDisk({
    data,
    name,
    baseDir,
  });

  if (!result) {
    return null;
  }

  return result.fullPath;
};

export const getSuggestedFilename = ({
  attachment,
  timestamp,
  index,
  scenario = 'saving-locally',
}: {
  attachment: Pick<AttachmentType, 'fileName' | 'contentType'>;
  timestamp?: number | Date;
  index?: number;
  scenario?: 'sending' | 'saving-locally';
}): string => {
  const { fileName } = attachment;
  if (fileName) {
    return fileName;
  }

  let prefix: string;
  switch (scenario) {
    case 'sending':
      // when sending, we prefer a generic 'signal-less' name
      prefix = 'image';
      break;
    case 'saving-locally':
      prefix = 'signal';
      break;
    default:
      throw missingCaseError(scenario);
  }

  const suffix = timestamp
    ? moment(timestamp).format('-YYYY-MM-DD-HHmmss')
    : '';
  const fileType = getFileExtension(attachment);
  const extension = fileType ? `.${fileType}` : '';
  const indexSuffix =
    isNumber(index) && index > 1
      ? `_${padStart(index.toString(), 3, '0')}`
      : '';

  return `${prefix}${suffix}${indexSuffix}${extension}`;
};

export const getFileExtension = (
  attachment: Pick<AttachmentType, 'contentType'>
): string | undefined => {
  if (!attachment.contentType) {
    return undefined;
  }

  switch (attachment.contentType) {
    case 'video/quicktime':
      return 'mov';
    case 'audio/mpeg':
      return 'mp3';
    default:
      return attachment.contentType.split('/')[1];
  }
};

export const defaultBlurHash = (theme: ThemeType = ThemeType.light): string => {
  if (theme === ThemeType.dark) {
    return 'L05OQnoffQofoffQfQfQfQfQfQfQ';
  }
  return 'L1Q]+w-;fQ-;~qfQfQfQfQfQfQfQ';
};

export const canBeDownloaded = (
  attachment: Pick<AttachmentType, 'digest' | 'key' | 'wasTooBig'>
): boolean => {
  return Boolean(attachment.digest && attachment.key && !attachment.wasTooBig);
};

export function doAttachmentsOnSameMessageMatch(
  attachmentA: AttachmentType,
  attachmentB: AttachmentType
): boolean {
  if (
    isValidPlaintextHash(attachmentA.plaintextHash) &&
    isValidPlaintextHash(attachmentB.plaintextHash)
  ) {
    return attachmentA.plaintextHash === attachmentB.plaintextHash;
  }

  if (isValidDigest(attachmentA.digest) && isValidDigest(attachmentB.digest)) {
    return attachmentA.digest === attachmentB.digest;
  }

  return false;
}

// TODO: DESKTOP-8910
// This "undownloaded" attachment signature can change once the file is downloaded; we may
// start with only the digest or plaintextHash, but both will be filled in by the time
// it's downloaded
export function getUndownloadedAttachmentSignature(
  attachment: AttachmentType
): string {
  return `${attachment.digest}.${attachment.plaintextHash}`;
}

export function cacheAttachmentBySignature(
  attachmentMap: Map<string, AttachmentType>,
  attachment: AttachmentType
): void {
  const { digest, plaintextHash } = attachment;
  if (digest) {
    attachmentMap.set(digest, attachment);
  }
  if (plaintextHash) {
    attachmentMap.set(plaintextHash, attachment);
  }
}

export function getCachedAttachmentBySignature<T>(
  attachmentMap: Map<string, T>,
  attachment: AttachmentType
): T | undefined {
  const { digest, plaintextHash } = attachment;
  if (digest) {
    if (attachmentMap.has(digest)) {
      return attachmentMap.get(digest);
    }
  }
  if (plaintextHash) {
    if (attachmentMap.has(plaintextHash)) {
      return attachmentMap.get(plaintextHash);
    }
  }
  return undefined;
}

export type AttachmentDownloadableFromTransitTier = WithRequiredProperties<
  AttachmentType,
  'key' | 'digest' | 'cdnKey' | 'cdnNumber'
>;

export type LocallySavedAttachment = WithRequiredProperties<
  AttachmentType,
  'path'
>;

// Extend range in case the attachment is actually still there (this function is meant to
// be optimistic)
const BUFFER_TIME_ON_TRANSIT_TIER = 5 * DAY;

export function mightStillBeOnTransitTier(
  attachment: Pick<AttachmentType, 'cdnKey' | 'cdnNumber' | 'uploadTimestamp'>
): boolean {
  if (!attachment.cdnKey) {
    return false;
  }
  if (attachment.cdnNumber == null) {
    return false;
  }

  if (!attachment.uploadTimestamp) {
    // Let's be conservative and still assume it might be downloadable
    return true;
  }

  if (
    isMoreRecentThan(
      attachment.uploadTimestamp,
      getMessageQueueTime() + BUFFER_TIME_ON_TRANSIT_TIER
    )
  ) {
    return true;
  }

  return false;
}

export type BackupableAttachmentType = WithRequiredProperties<
  AttachmentType,
  'plaintextHash' | 'key'
>;

export function hasRequiredInformationForBackup(
  attachment: AttachmentType
): attachment is BackupableAttachmentType {
  return (
    isValidAttachmentKey(attachment.key) &&
    isValidPlaintextHash(attachment.plaintextHash)
  );
}

export function wasImportedFromLocalBackup(
  attachment: AttachmentType
): attachment is BackupableAttachmentType {
  return (
    hasRequiredInformationForBackup(attachment) &&
    Boolean(attachment.localBackupPath) &&
    isValidAttachmentKey(attachment.localKey)
  );
}

export function canAttachmentHaveThumbnail({
  contentType,
}: Pick<AttachmentType, 'contentType'>): boolean {
  return isVideoTypeSupported(contentType) || isImageTypeSupported(contentType);
}

export function hasRequiredInformationToDownloadFromTransitTier(
  attachment: AttachmentType
): attachment is AttachmentDownloadableFromTransitTier {
  const hasIntegrityCheck =
    isValidDigest(attachment.digest) ||
    isValidPlaintextHash(attachment.plaintextHash);
  if (!hasIntegrityCheck) {
    return false;
  }

  if (!isValidAttachmentKey(attachment.key)) {
    return false;
  }

  if (!attachment.cdnKey || attachment.cdnNumber == null) {
    return false;
  }

  return true;
}

export function shouldAttachmentEndUpInRemoteBackup({
  attachment,
  hasMediaBackups,
}: {
  attachment: AttachmentType;
  hasMediaBackups: boolean;
}): boolean {
  return hasMediaBackups && hasRequiredInformationForBackup(attachment);
}

export function isDownloadable(attachment: AttachmentType): boolean {
  return (
    hasRequiredInformationToDownloadFromTransitTier(attachment) ||
    shouldAttachmentEndUpInRemoteBackup({
      attachment,
      // TODO: DESKTOP-8905
      hasMediaBackups: true,
    })
  );
}

export function isAttachmentLocallySaved(
  attachment: AttachmentType
): attachment is LocallySavedAttachment {
  return Boolean(attachment.path);
}

export function getAttachmentIdForLogging(attachment: AttachmentType): string {
  const { digest } = attachment;
  if (typeof digest === 'string') {
    return redactGenericText(digest);
  }
  return '[MissingDigest]';
}

// We now partition out the bodyAttachment on receipt, but older
// messages may still have a bodyAttachment in the normal attachments field
export function partitionBodyAndNormalAttachments<
  T extends Pick<AttachmentType, 'contentType'>,
>(
  {
    attachments,
    existingBodyAttachment,
  }: {
    attachments: ReadonlyArray<T>;
    existingBodyAttachment?: T;
  },
  { logId, logger = logging }: { logId: string; logger?: LoggerType }
): {
  bodyAttachment: T | undefined;
  attachments: Array<T>;
} {
  const [bodyAttachments, normalAttachments] = partition(
    attachments,
    attachment => MIME.isLongMessage(attachment.contentType)
  );

  if (bodyAttachments.length > 1) {
    logger.warn(
      `${logId}: Received more than one long message attachment, ` +
        `dropping ${bodyAttachments.length - 1}`
    );
  }

  if (bodyAttachments.length > 0) {
    if (existingBodyAttachment) {
      logger.warn(`${logId}: there is already an existing body attachment`);
    } else {
      logger.info(
        `${logId}: Moving a long message attachment to message.bodyAttachment`
      );
    }
  }

  return {
    bodyAttachment: existingBodyAttachment ?? bodyAttachments[0],
    attachments: normalAttachments,
  };
}
