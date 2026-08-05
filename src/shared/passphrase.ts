/**
 * Rules for the passphrase that protects the passwords inside a connections
 * export. The file leaves the machine, so this is the only thing standing
 * between whoever ends up with it and every database password in it.
 */

export const PASSPHRASE_MIN_LENGTH = 15

export interface PassphraseRule {
  label: string
  test(value: string): boolean
}

export const PASSPHRASE_RULES: readonly PassphraseRule[] = [
  {
    label: `At least ${PASSPHRASE_MIN_LENGTH} characters`,
    test: (v) => v.length >= PASSPHRASE_MIN_LENGTH
  },
  { label: 'At least one uppercase letter', test: (v) => /[A-Z]/.test(v) },
  { label: 'At least one number', test: (v) => /[0-9]/.test(v) },
  { label: 'At least one symbol', test: (v) => /[^A-Za-z0-9]/.test(v) }
]

export function isPassphraseValid(value: string): boolean {
  return PASSPHRASE_RULES.every((rule) => rule.test(value))
}
