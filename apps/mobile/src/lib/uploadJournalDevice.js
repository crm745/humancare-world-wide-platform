// The app's one upload journal, on the phone's secure storage (the same Keychain / Keystore the sign-in tokens and the Phase 4 submission keys use). See lib/uploadJournal.js.
import { currentAccountId, deviceStorage } from './pendingSubmissionStore';
import { createUploadJournal } from './uploadJournal';

export const uploadJournal = createUploadJournal({ storage: deviceStorage, getUserId: currentAccountId });
