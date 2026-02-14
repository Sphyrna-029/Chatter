export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const USERNAME_INVALID_CHAR_PATTERN = /[^A-Za-z0-9_]/;
const USERNAME_INVALID_CHAR_REPLACE_PATTERN = /[^A-Za-z0-9_]/g;

export function validateUsername(usernameInput: string): string | null {
  const username = usernameInput.trim();

  if (!username) {
    return "Username is required.";
  }

  if (
    username.length < USERNAME_MIN_LENGTH ||
    username.length > USERNAME_MAX_LENGTH
  ) {
    return `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters long.`;
  }

  if (!USERNAME_PATTERN.test(username)) {
    return "Username may only contain letters, numbers, and underscores.";
  }

  return null;
}

export function hasInvalidUsernameChars(input: string): boolean {
  return USERNAME_INVALID_CHAR_PATTERN.test(input);
}

export function sanitizeUsernameInput(input: string): string {
  return input
    .replace(USERNAME_INVALID_CHAR_REPLACE_PATTERN, "")
    .slice(0, USERNAME_MAX_LENGTH);
}
