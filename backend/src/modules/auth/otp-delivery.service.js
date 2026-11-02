// Sends the OTP codes the backend generates itself.
//
// Email codes go out by email (src/lib/mailer.js). Real SMS codes are sent and checked by
// Firebase from the app (PHONE_OTP_PROVIDER=firebase, see src/integrations/firebase/firebase.js), so the
// backend never texts anyone: if it is asked to (Firebase mode off), it only prints the
// code to the server log for local testing, and refuses in production.
const { sendMail } = require('../../lib/mailer');

const PURPOSE_LABEL = {
  patient_register: 'HumanCare registration',
  patient_login: 'HumanCare login',
  patient_change_mobile: 'HumanCare mobile number change',
  patient_change_email: 'HumanCare email change',
  patient_password_reset: 'HumanCare password reset',
  corporate_login: 'HumanCare login',
  corporate_password_reset: 'HumanCare password reset',
};

function isEmail(identifier) {
  return identifier.includes('@');
}

async function sendOtpEmail(email, code, label) {
  await sendMail({
    to: email,
    subject: `${code} is your ${label} code`,
    text: `Your ${label} verification code is ${code}. It expires in 5 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Your ${label} verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p><p>It expires in 5 minutes. If you didn't request this, you can ignore this email.</p>`,
  });
}

// Development only: with Firebase mode off there is no SMS sender, so print the code.
async function logSmsForDevelopment(mobile, code, label) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SMS codes are sent by Firebase — set PHONE_OTP_PROVIDER=firebase in production');
  }
  console.log(`[DEV ONLY — SMS not sent] ${label} code for ${mobile}: ${code}`);
}

// Unlike Bitrix24, a failed OTP send is something the person needs to know about
// immediately (they'd just be stuck waiting for a code that never arrives), so this
// throws on failure rather than swallowing the error.
async function deliverOtp(identifier, code, purpose) {
  const label = PURPOSE_LABEL[purpose] || 'HumanCare';
  if (isEmail(identifier)) {
    await sendOtpEmail(identifier, code, label);
  } else {
    await logSmsForDevelopment(identifier, code, label);
  }
}

module.exports = { deliverOtp };
