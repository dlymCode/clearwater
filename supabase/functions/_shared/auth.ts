import { type Db } from "./db.ts";
import { bearerToken, HttpError } from "./http.ts";

export interface AuthedUser {
  id: string;
}

/**
 * Resolve the caller from their Supabase access token. The service-role key is not a user token:
 * auth.getUser rejects it, so it gets a 401 here and cannot impersonate a user.
 */
export async function authenticate(req: Request, db: Pick<Db, "auth">): Promise<AuthedUser> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "unauthenticated", "Missing bearer token.");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "unauthenticated", "Invalid or expired token.");
  return { id: data.user.id.toLowerCase() };
}
