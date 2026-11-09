import { http } from '@/services/http';

/**
 * GET /admin/cases. The API returns every Case (patient-request Cases and corporate Cases) as { cases }.
 * It accepts only `status` (submitted | scheduled | in_progress | completed | cancelled); it has no
 * search, paging or request reference, so the page searches and pages the list itself.
 */
export async function listCases({ status, signal } = {}) {
  const params = {};
  if (status) params.status = status;
  const { data } = await http.get('/admin/cases', { params, signal });
  return Array.isArray(data.cases) ? data.cases : [];
}

/** GET /admin/cases/:id (the numeric id or the CASE-... reference). Resolves with the Case. 404 when unknown. */
export async function getCase(id, { signal } = {}) {
  const { data } = await http.get(`/admin/cases/${encodeURIComponent(id)}`, { signal });
  return data.case;
}
