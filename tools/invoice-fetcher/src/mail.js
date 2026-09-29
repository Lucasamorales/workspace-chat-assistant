// Sending, and nothing else: the words come from plan.js, the password from secret.js.
const nodemailer = require('nodemailer');

function createMailer(config, { password, transport = null }) {
  const t = transport || nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.port === 465,
    auth: { user: config.mail.from, pass: password },
  });
  const send = ({ subject, text, attachments = [] }) => t.sendMail({
    from: `Buddy invoice fetcher <${config.mail.from}>`,
    to: config.mail.to.join(', '),
    subject,
    text,
    attachments,
  });
  return { send, verify: () => (t.verify ? t.verify() : Promise.resolve(true)) };
}

module.exports = { createMailer };
