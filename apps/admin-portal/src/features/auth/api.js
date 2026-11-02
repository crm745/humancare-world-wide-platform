import { http } from '@/services/http';

const quiet = { skipUnauthorizedEvent: true };

// Resolves with the admin, or rejects with an ApiError (401 = no valid session).
export async function fetchSession() {
  const { data } = await http.get('/admin/me', quiet);
  return data.admin;
}

// The response body also carries `token`/`refreshToken` for non-browser clients. They
// are deliberately dropped here: the session lives only in the HTTP-only cookie.
export async function loginRequest(email, password) {
  const { data } = await http.post('/admin/login', { email, password }, quiet);
  return { name: data.admin?.name ?? null, email: data.admin?.email ?? email };
}

export async function logoutRequest() {
  await http.post('/admin/logout', null, quiet);
}
