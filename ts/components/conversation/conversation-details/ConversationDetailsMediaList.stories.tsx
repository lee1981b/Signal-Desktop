// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { action } from '@storybook/addon-actions';
import type { Meta } from '@storybook/react';
import type { Props } from './ConversationDetailsMediaList';
import { ConversationDetailsMediaList } from './ConversationDetailsMediaList';
import type { MediaItemType } from '../../../types/MediaItem';
import { getDefaultConversation } from '../../../test-helpers/getDefaultConversation';
import {
  createPreparedMediaItems,
  createRandomMedia,
} from '../media-gallery/utils/mocks';

const { i18n } = window.SignalContext;

export default {
  title: 'Components/Conversation/ConversationDetails/ConversationMediaList',
} satisfies Meta<Props>;

const createProps = (mediaItems?: Array<MediaItemType>): Props => ({
  conversation: getDefaultConversation({
    recentMediaItems: mediaItems || [],
  }),
  i18n,
  loadRecentMediaItems: action('loadRecentMediaItems'),
  showAllMedia: action('showAllMedia'),
  showLightbox: action('showLightbox'),
});

export function Basic(): JSX.Element {
  const mediaItems = createPreparedMediaItems(createRandomMedia);
  const props = createProps(mediaItems);

  return <ConversationDetailsMediaList {...props} />;
}
