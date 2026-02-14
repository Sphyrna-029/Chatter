export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

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
