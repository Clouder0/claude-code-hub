export function shouldDefaultExpandUser(
  userId: number,
  currentUserId: number | undefined,
  isAdmin: boolean
): boolean {
  return !isAdmin && currentUserId === userId;
}
