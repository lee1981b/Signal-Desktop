// Copyright 2025 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import type { FormEvent } from 'react';
import React, { memo, useCallback, useRef } from 'react';
import { CC_CVC_FORMATTER, useInputMask } from '../../../hooks/useInputMask';
import type { LocalizerType } from '../../../types/I18N';
import { CardCvcError } from '../../../types/DonationsCardForm';
import { missingCaseError } from '../../../util/missingCaseError';

export function getCardCvcErrorMessage(
  _i18n: LocalizerType,
  error: CardCvcError
): string {
  switch (error) {
    case CardCvcError.EMPTY:
      return 'EMPTY';
    case CardCvcError.LENGTH_TOO_SHORT:
      return 'LENGTH_TOO_SHORT';
    case CardCvcError.INVALID_CHARS:
    case CardCvcError.LENGTH_TOO_LONG:
    case CardCvcError.LENGTH_INVALID:
      return 'INVALID';
    default:
      throw missingCaseError(error);
  }
}

export type DonateInputCardCvcProps = Readonly<{
  id: string;
  value: string;
  onValueChange: (newValue: string) => void;
  maxInputLength: number;
  onBlur?: () => void;
}>;

export const DonateInputCardCvc = memo(function DonateInputCardCvc(
  props: DonateInputCardCvcProps
) {
  const { onValueChange } = props;
  const inputRef = useRef<HTMLInputElement>(null);

  useInputMask(inputRef, CC_CVC_FORMATTER);

  const handleInput = useCallback(
    (event: FormEvent<HTMLInputElement>) => {
      onValueChange(event.currentTarget.value);
    },
    [onValueChange]
  );

  return (
    <input
      ref={inputRef}
      id={props.id}
      placeholder="123"
      type="text"
      inputMode="numeric"
      autoComplete="cc-csc"
      maxLength={props.maxInputLength}
      value={props.value}
      onInput={handleInput}
      onBlur={props.onBlur}
    />
  );
});
