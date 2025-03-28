// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { convertShortName } from '../emoji/lib';
import type { Props as EmojiPickerProps } from '../emoji/EmojiPicker';
import { useDelayedRestoreFocus } from '../../hooks/useRestoreFocus';
import type { LocalizerType } from '../../types/Util';
import {
  ReactionPickerPicker,
  ReactionPickerPickerEmojiButton,
  ReactionPickerPickerMoreButton,
  ReactionPickerPickerStyle,
} from '../ReactionPickerPicker';
import type { EmojiSkinTone } from '../fun/data/emojis';

export type RenderEmojiPickerProps = Pick<Props, 'onClose' | 'style'> &
  Pick<
    EmojiPickerProps,
    'onClickSettings' | 'onPickEmoji' | 'onEmojiSkinToneDefaultChange'
  > & {
    ref: React.Ref<HTMLDivElement>;
  };

export type OwnProps = {
  i18n: LocalizerType;
  selected?: string;
  onClose?: () => unknown;
  onPick: (emoji: string) => unknown;
  onEmojiSkinToneDefaultChange: (emojiSkinTone: EmojiSkinTone) => unknown;
  openCustomizePreferredReactionsModal?: () => unknown;
  preferredReactionEmoji: ReadonlyArray<string>;
  renderEmojiPicker: (props: RenderEmojiPickerProps) => React.ReactElement;
};

export type Props = OwnProps & Pick<React.HTMLProps<HTMLDivElement>, 'style'>;

export const ReactionPicker = React.forwardRef<HTMLDivElement, Props>(
  function ReactionPickerInner(
    {
      i18n,
      onClose,
      onPick,
      onEmojiSkinToneDefaultChange,
      openCustomizePreferredReactionsModal,
      preferredReactionEmoji,
      renderEmojiPicker,
      selected,
      style,
    },
    ref
  ) {
    const [pickingOther, setPickingOther] = React.useState(false);

    // Handle escape key
    React.useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (onClose && e.key === 'Escape' && !pickingOther) {
          onClose();
        }
      };

      document.addEventListener('keydown', handler);

      return () => {
        document.removeEventListener('keydown', handler);
      };
    }, [onClose, pickingOther]);

    // Handle EmojiPicker::onPickEmoji
    const onPickEmoji: EmojiPickerProps['onPickEmoji'] = React.useCallback(
      ({ shortName, skinTone: pickedSkinTone }) => {
        onPick(convertShortName(shortName, pickedSkinTone));
      },
      [onPick]
    );

    // Focus first button and restore focus on unmount
    const [focusRef] = useDelayedRestoreFocus();

    if (pickingOther) {
      return renderEmojiPicker({
        onClickSettings: openCustomizePreferredReactionsModal,
        onClose,
        onPickEmoji,
        onEmojiSkinToneDefaultChange,
        ref,
        style,
      });
    }

    const otherSelected =
      selected && !preferredReactionEmoji.includes(selected);

    let moreButton: React.ReactNode;
    if (otherSelected) {
      moreButton = (
        <ReactionPickerPickerEmojiButton
          emoji={selected}
          onClick={() => {
            onPick(selected);
          }}
          isSelected
          title={i18n('icu:Reactions--remove')}
        />
      );
    } else {
      moreButton = (
        <ReactionPickerPickerMoreButton
          i18n={i18n}
          onClick={() => {
            setPickingOther(true);
          }}
        />
      );
    }

    // This logic is here to avoid selecting duplicate emoji.
    let hasSelectedSomething = false;

    return (
      <ReactionPickerPicker
        isSomethingSelected={typeof selected === 'number'}
        pickerStyle={ReactionPickerPickerStyle.Picker}
        ref={ref}
        style={style}
      >
        {preferredReactionEmoji.map((emoji, index) => {
          const maybeFocusRef = index === 0 ? focusRef : undefined;

          const isSelected = !hasSelectedSomething && emoji === selected;
          if (isSelected) {
            hasSelectedSomething = true;
          }

          return (
            <ReactionPickerPickerEmojiButton
              emoji={emoji}
              isSelected={isSelected}
              // The index is the only thing that uniquely identifies the emoji, because
              //   there can be duplicates in the list.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              onClick={() => {
                onPick(emoji);
              }}
              ref={maybeFocusRef}
            />
          );
        })}
        {moreButton}
      </ReactionPickerPicker>
    );
  }
);
