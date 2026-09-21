// REFERENCE ONLY — the live Apps Script this module replaces. Do not run from here.
// The service account private key that was inlined here has been removed on purpose:
// it allowed impersonating any user in the domain. See docs/decisions/0003-ooo.md.

// ==========================================
// CONFIGURATION
// ==========================================
const SERVICE_ACCOUNT_KEY = {
  "client_email": "leave-bot@your-leave-project.iam.gserviceaccount.com",
  "private_key": "[REDACTED — rotate this key; Buddy signs its own tokens instead]"
};

const SHIFTS = {
  "UK_9_5": { tz: "Europe/London", start: "09:00:00", mid: "13:00:00", end: "17:00:00" },
  "ARG_6_3": { tz: "America/Argentina/Buenos_Aires", start: "06:00:00", mid: "10:30:00", end: "15:00:00" },
  "ARG_7_4": { tz: "America/Argentina/Buenos_Aires", start: "07:00:00", mid: "11:30:00", end: "16:00:00" },
  "ARG_8_5": { tz: "America/Argentina/Buenos_Aires", start: "08:00:00", mid: "12:30:00", end: "17:00:00" }
};

// ==========================================
// UI MENU & DIALOGS
// ==========================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🌴 Leave Automation')
    .addItem('Create Leave (Multi-Day/Half-Day)', 'openCreateDialog')
    .addItem('Cancel Leave', 'openCancelDialog')
    .addToUi();
}

function openCreateDialog() {
  const html = HtmlService.createHtmlOutputFromFile('create')
    .setWidth(600).setHeight(680);
  SpreadsheetApp.getUi().showModalDialog(html, 'Create OOO Events');
}

function openCancelDialog() {
  const html = HtmlService.createHtmlOutputFromFile('cancel')
    .setWidth(500).setHeight(400);
  SpreadsheetApp.getUi().showModalDialog(html, 'Cancel OOO Events');
}

// ==========================================
// FORM PROCESSOR
// ==========================================
function processLeaveData(formData) {
  const { email, nickname, shift, inviteEmail, leaves } = formData;
  const shiftData = SHIFTS[shift];
  let successCount = 0;
  let errorLog = [];

  leaves.forEach(leave => {
    const anchorDate = new Date(`${leave.start}T12:00:00Z`);
    const anchorEndDate = new Date(`${leave.end}T12:00:00Z`);

    let startStr, endStr;
    let allDayStartStr, allDayEndStr;

    if (leave.type === "full") {
      startStr = Utilities.formatDate(anchorDate, shiftData.tz, "yyyy-MM-dd'T'00:00:00XXX");
      endStr = Utilities.formatDate(anchorEndDate, shiftData.tz, "yyyy-MM-dd'T'23:59:59XXX");

      allDayStartStr = leave.start;
      const [y, m, d] = leave.end.split('-');
      const exclusiveEndDate = new Date(y, m - 1, d);
      exclusiveEndDate.setDate(exclusiveEndDate.getDate() + 1);
      allDayEndStr = Utilities.formatDate(exclusiveEndDate, "UTC", "yyyy-MM-dd");

    } else if (leave.type === "am") {
      startStr = Utilities.formatDate(anchorDate, shiftData.tz, `yyyy-MM-dd'T'${shiftData.start}XXX`);
      endStr = Utilities.formatDate(anchorDate, shiftData.tz, `yyyy-MM-dd'T'${shiftData.mid}XXX`);
    } else if (leave.type === "pm") {
      startStr = Utilities.formatDate(anchorDate, shiftData.tz, `yyyy-MM-dd'T'${shiftData.mid}XXX`);
      endStr = Utilities.formatDate(anchorDate, shiftData.tz, `yyyy-MM-dd'T'${shiftData.end}XXX`);
    }

    // A. Inject OOO Block
    const personalRes = createOOOEvent(email.trim(), nickname, startStr, endStr);

    // B. Inject Team Invite
    let groupRes = "success";
    if (inviteEmail && inviteEmail.trim() !== "") {
      if (leave.type === "full") {
        groupRes = createGroupInviteAllDay(email.trim(), nickname, allDayStartStr, allDayEndStr, inviteEmail.trim());
      } else {
        groupRes = createGroupInviteTimed(email.trim(), nickname, startStr, endStr, inviteEmail.trim());
      }
    }

    if (personalRes === "success" && groupRes === "success") {
      successCount++;
    } else {
      errorLog.push(`Failed for ${leave.start}: OOO[${personalRes}] / Group[${groupRes}]`);
    }
  });

  if (errorLog.length > 0) throw new Error(errorLog.join("\n"));
  return `Successfully processed ${successCount} leave block(s) for ${nickname}.`;
}

// ==========================================
// CANCELLATION PROCESSOR
// ==========================================
function processCancelData(formData) {
  const { email, start, end } = formData;

  const service = getOAuthService(email.trim());
  if (!service.hasAccess()) throw new Error(`Auth failed for ${email}`);

  const timeMin = encodeURIComponent(`${start}T00:00:00Z`);
  const [y, m, d] = end.split('-');
  const endDateObj = new Date(Date.UTC(y, m - 1, d));
  endDateObj.setDate(endDateObj.getDate() + 2);
  const timeMax = encodeURIComponent(endDateObj.toISOString());

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&q=OOO`;
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + service.getAccessToken() }, muteHttpExceptions: true });

  if (res.getResponseCode() !== 200) throw new Error("Could not search calendar: " + res.getContentText());

  const events = JSON.parse(res.getContentText()).items || [];
  let deleted = 0;
  events.forEach(ev => {
    if (ev.summary && ev.summary.includes("(OOO)")) {
      const delRes = UrlFetchApp.fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${ev.id}`, {
        method: 'delete',
        headers: { Authorization: 'Bearer ' + service.getAccessToken() },
        muteHttpExceptions: true
      });
      if (delRes.getResponseCode() === 204) deleted++;
    }
  });

  return `Successfully deleted ${deleted} OOO event(s).`;
}

// ==========================================
// CORE API INJECTION
// ==========================================
function getOAuthService(userEmail) {
  return OAuth2.createService('ServiceAccount_' + userEmail)
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(SERVICE_ACCOUNT_KEY.private_key)
    .setIssuer(SERVICE_ACCOUNT_KEY.client_email)
    .setSubject(userEmail)
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setScope('https://www.googleapis.com/auth/calendar');
}

function createOOOEvent(employeeEmail, nickname, startStr, endStr) {
  const service = getOAuthService(employeeEmail);
  if (!service.hasAccess()) return "Auth Failed";
  const payload = {
    summary: `${nickname} (OOO)`,
    eventType: "outOfOffice",
    transparency: "opaque",
    outOfOfficeProperties: {
      autoDeclineMode: "declineOnlyNewConflictingInvitations",
      declineMessage: "I am currently out of the office and will respond upon my return."
    },
    start: { dateTime: startStr },
    end: { dateTime: endStr }
  };
  return sendToGoogleAPI(service, payload, false);
}

function createGroupInviteAllDay(employeeEmail, nickname, startStr, endStr, targetEmail) {
  const service = getOAuthService(employeeEmail);
  if (!service.hasAccess()) return "Auth Failed";
  const payload = {
    summary: `${nickname} (OOO)`,
    transparency: "transparent",
    attendees: [{ email: targetEmail }],
    start: { date: startStr },
    end: { date: endStr }
  };
  return sendToGoogleAPI(service, payload, true);
}

function createGroupInviteTimed(employeeEmail, nickname, startStr, endStr, targetEmail) {
  const service = getOAuthService(employeeEmail);
  if (!service.hasAccess()) return "Auth Failed";
  const payload = {
    summary: `${nickname} (OOO)`,
    transparency: "transparent",
    attendees: [{ email: targetEmail }],
    start: { dateTime: startStr },
    end: { dateTime: endStr }
  };
  return sendToGoogleAPI(service, payload, true);
}

function sendToGoogleAPI(service, payload, isGroupInvite) {
  const urlParams = isGroupInvite ? "?sendUpdates=none" : "";
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${urlParams}`, options);
  return response.getResponseCode() === 200 ? "success" : response.getContentText();
}
