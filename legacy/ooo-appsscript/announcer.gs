// REFERENCE ONLY — the live Apps Script Chat bot that answers "who is out".
// Buddy's ooo module replaces this; see docs/decisions/0003-ooo.md.

const TARGET_CALENDAR = "wholeteam@example.com";

function onMessage(event) {
  const message = event.message.text.toLowerCase();

  if (message.includes("today")) {
    return fetchOOO("today");
  } else if (message.includes("tomorrow")) {
    return fetchOOO("tomorrow");
  } else {
    return fetchOOO("week");
  }
}

function fetchOOO(timeframe) {
  const cal = CalendarApp.getCalendarById(TARGET_CALENDAR);
  if (!cal) {
    return { text: "❌ I cannot access the team calendar. Ensure my creator has permission to view it." };
  }

  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (timeframe === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (timeframe === "tomorrow") {
    start.setDate(now.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setHours(23, 59, 59, 999);
  } else { // 'week'
    const dayOfWeek = now.getDay() || 7; // Force Sunday to be 7
    start.setDate(now.getDate() - dayOfWeek + 1); // Monday
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(start.getDate() + 6); // Sunday
    end.setHours(23, 59, 59, 999);
  }

  const events = cal.getEvents(start, end, { search: "(OOO)" });

  if (events.length === 0) {
    return { text: `Nobody is scheduled to be out of the office ${timeframe === 'week' ? 'this week' : timeframe}. 🎉` };
  }

  let responseText = `🌴 *Here is who is out ${timeframe === 'week' ? 'this week' : timeframe}:*\n\n`;

  events.forEach(ev => {
    const title = ev.getTitle().replace("(OOO)", "").trim();
    const evStart = ev.getStartTime();
    const evEnd = ev.getEndTime();

    let dateString = "";

    if (ev.isAllDayEvent()) {
      const formattedStart = Utilities.formatDate(evStart, "America/Argentina/Buenos_Aires", "MMM d");
      // Google's all-day end dates are exclusive, so subtract a minute for the real final day
      const actualEnd = new Date(evEnd.getTime() - 60000);
      const formattedEnd = Utilities.formatDate(actualEnd, "America/Argentina/Buenos_Aires", "MMM d");

      dateString = (formattedStart === formattedEnd) ? formattedStart : `${formattedStart} to ${formattedEnd}`;
    } else {
      const formattedDate = Utilities.formatDate(evStart, "America/Argentina/Buenos_Aires", "MMM d");
      const timeStart = Utilities.formatDate(evStart, "America/Argentina/Buenos_Aires", "HH:mm");
      const timeEnd = Utilities.formatDate(evEnd, "America/Argentina/Buenos_Aires", "HH:mm");
      dateString = `${formattedDate} (${timeStart} - ${timeEnd} ARG)`;
    }

    responseText += `• *${title}*: ${dateString}\n`;
  });

  return { text: responseText };
}
