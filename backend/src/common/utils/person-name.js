// The person's name on sign-up. The Create Account form sends firstName and lastName; older app
// versions (and the Google/Apple step, where the provider gives one name) send a single `name`.
// `name` stays the full name ("first last") that the rest of the app shows and sends to Bitrix;
// firstName and lastName are stored beside it only when the person typed them as two names.
// Nothing splits an existing `name` into two: that would be a guess.

const MAX_PART = 50; // the first_name and last_name columns are VARCHAR(50)

const squash = (value) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');
const validPart = (part) => part.length >= 1 && part.length <= MAX_PART && /\p{L}/u.test(part);

// Returns { name, firstName, lastName } (the last two null for a single `name`), { missing: true }
// when no name was sent at all, or { error } for a name that is sent but not acceptable.
function readNameFields(body) {
  const firstName = squash(body.firstName);
  const lastName = squash(body.lastName);
  if (firstName || lastName) {
    if (!validPart(firstName) || !validPart(lastName)) return { error: 'Enter your first name and your last name.' };
    return { name: `${firstName} ${lastName}`, firstName, lastName };
  }
  if (!body.name) return { missing: true };
  const name = String(body.name).trim();
  if (name.length < 2) return { error: 'Enter a valid name.' };
  return { name, firstName: null, lastName: null };
}

module.exports = { readNameFields, MAX_PART };
