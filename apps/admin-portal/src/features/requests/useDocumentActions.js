import { useCallback, useRef, useState } from 'react';
import { approveRequest, downloadDocument, requestDocuments, reviewDocument } from './api';
import { blockerMessages } from './approval.mjs';
import { saveBlob } from './saveBlob';

// 404 and 409 from these endpoints mean the request or document is no longer what the page showed
// (another Admin decided it, the patient replaced it, the request was approved, the file failed its
// check). They are not retried; the page is refreshed so the Admin sees the current state.
const isStale = (err) => err.status === 404 || err.status === 409;

/**
 * Download, review and "request additional documents" actions for one request.
 *  - `dialog`:        null, or { type: 'approve' | 'reject', doc } while a review confirmation is open.
 *  - `requestDialog`: true while the "request additional documents" dialog is open.
 *  - `notice`:        { tone: 'success' | 'warning' | 'error', text } for the page to show.
 *  - `error`:         a failure to show inside the open dialog (validation or network; it stays open).
 *  - `busy`:          a decision or a request is being saved.
 * One consequential action runs at a time: a second click while one is in flight does nothing, even before
 * React has re-rendered the disabled button (the ref is checked synchronously). That includes a click on a
 * different decision, so a review and a document request can never overlap.
 * `onChanged` refetches the request; it runs after a success and after a stale (404/409) answer.
 */
export function useDocumentActions(requestId, { onChanged }) {
  const [dialog, setDialog] = useState(null);
  const [requestDialog, setRequestDialog] = useState(false);
  const [approveDialog, setApproveDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const saving = useRef(false); // a review or a document request is in flight
  const downloading = useRef(false);

  const openDialog = useCallback((type, doc) => {
    setNotice(null);
    setError(null);
    setDialog({ type, doc });
  }, []);

  const closeDialog = useCallback(() => {
    if (saving.current) return;
    setDialog(null);
    setError(null);
  }, []);

  const submitReview = useCallback(
    async (reason) => {
      if (saving.current || !dialog) return;
      saving.current = true;
      setBusy(true);
      setError(null);
      const { type, doc } = dialog;
      const decision = type === 'approve' ? 'approved' : 'rejected';
      try {
        await reviewDocument(requestId, doc.id, { decision, reason });
        setDialog(null);
        setNotice({
          tone: 'success',
          text: type === 'approve' ? `"${doc.originalName}" was approved.` : `"${doc.originalName}" was rejected. The patient will be asked to upload a replacement.`,
        });
        onChanged();
      } catch (err) {
        if (isStale(err)) {
          setDialog(null);
          setNotice({ tone: 'warning', text: `${err.message} The page has been refreshed with the current state.` });
          onChanged();
        } else {
          setError(err.message || 'The decision could not be saved. Please try again.');
        }
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [dialog, requestId, onChanged],
  );

  const openRequestDialog = useCallback(() => {
    setNotice(null);
    setError(null);
    setRequestDialog(true);
  }, []);

  const closeRequestDialog = useCallback(() => {
    if (saving.current) return;
    setRequestDialog(false);
    setError(null);
  }, []);

  // `reason` has already been validated and trimmed by the dialog; the server checks it again.
  const submitRequestDocuments = useCallback(
    async (reason) => {
      if (saving.current || !requestDialog) return;
      saving.current = true;
      setBusy(true);
      setError(null);
      try {
        await requestDocuments(requestId, reason);
        setRequestDialog(false);
        setNotice({ tone: 'success', text: 'Additional documents were requested. The patient will see your reason and can upload new documents against this request.' });
        onChanged();
      } catch (err) {
        if (isStale(err)) {
          setRequestDialog(false);
          setNotice({ tone: 'warning', text: `${err.message} The page has been refreshed with the current state.` });
          onChanged();
        } else {
          setError(err.message || 'The request could not be sent. Please try again.');
        }
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [requestDialog, requestId, onChanged],
  );

  const openApproveDialog = useCallback(() => {
    setNotice(null);
    setError(null);
    setApproveDialog(true);
  }, []);

  const closeApproveDialog = useCallback(() => {
    if (saving.current) return;
    setApproveDialog(false);
    setError(null);
  }, []);

  // Approves the request; the BACKEND creates the Case in its own transaction. Nothing is assumed locally:
  // on success the page refetches and shows what the server now holds.
  const submitApproval = useCallback(async () => {
    if (saving.current || !approveDialog) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await approveRequest(requestId);
      setApproveDialog(false);
      const ref = result.case?.referenceNumber;
      setNotice({
        tone: 'success',
        text: result.alreadyApproved
          ? `This request was already approved${ref ? `. Its Case is ${ref}.` : '.'}`
          : `The request was approved${ref ? ` and Case ${ref} was created.` : '.'}`,
      });
      onChanged();
    } catch (err) {
      if (err.status === 409 || err.status === 404) {
        // Blocked (documents changed since the page loaded) or gone: explain, then show the current state.
        setApproveDialog(false);
        setNotice({
          tone: 'warning',
          text: `${err.message} The page has been refreshed with the current state.`,
          items: err.code === 'approval_blocked' ? blockerMessages(err.body) : [],
        });
        onChanged();
      } else {
        // 400, network and server errors keep the dialog open so the Admin can retry. A 401 also
        // fires the global session event, which sends the Admin to login.
        setError(err.message || 'The request could not be approved. Please try again.');
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }, [approveDialog, requestId, onChanged]);

  const download = useCallback(
    async (doc) => {
      if (downloading.current) return;
      downloading.current = true;
      setDownloadingId(doc.id);
      setNotice(null);
      try {
        const { blob, filename } = await downloadDocument(requestId, doc);
        saveBlob(blob, filename);
        // The server records a `document_downloaded` event for every successful download: fetch the
        // request again so it shows in the timeline straight away.
        onChanged();
      } catch (err) {
        setNotice({ tone: 'error', text: `"${doc.originalName}" could not be downloaded. ${err.message}` });
        if (isStale(err)) onChanged();
      } finally {
        downloading.current = false;
        setDownloadingId(null);
      }
    },
    [requestId, onChanged],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    dialog, requestDialog, approveDialog, busy, error, notice, downloadingId,
    openDialog, closeDialog, submitReview,
    openRequestDialog, closeRequestDialog, submitRequestDocuments,
    openApproveDialog, closeApproveDialog, submitApproval,
    download, dismissNotice,
  };
}
