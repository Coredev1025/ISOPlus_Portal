import axios from "@/app/utils/axiosConfig";
import { dedupeByKey } from "@/app/utils/requestDedupe";

const VERIFY_KEY = "auth:verify";

/**
 * One in-flight GET /api/auth/verify for the whole app (avoids duplicate calls on
 * Strict Mode remount or Header + page both checking session).
 */
export function verifySession(): Promise<any> {
  return dedupeByKey(VERIFY_KEY, async () => {
    try {
      return await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/auth/verify`, {
        withCredentials: true,
      });
    } catch (error: any) {
      if (error.name === "CanceledError" || error.name === "AbortError") {
        return false;
      }
      console.error("Error verifying token", error);
      return error;
    }
  });
}

/**
 * @param _signal Ignored — verification is deduped app-wide; use {@link verifySession} instead.
 */
export const isTokenValid = async (_signal?: AbortSignal): Promise<any> => {
  return verifySession();
};