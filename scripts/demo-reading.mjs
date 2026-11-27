/**
 * Demo-only mail for the reader: a message whose files are inside a
 * winmail.dat, and two that read right to left. Every name and sentence here
 * is invented.
 */
const now = Date.now();
const row = (id, over) => ({
  id, account_id: "a1", mid: `<${id}@demo>`, pid: id, thread_key: `t-${id}`, folder: "inbox",
  to_line: "you@icloud.com", cc_line: "", bcc_line: "", unread: 0, starred: 0, n: 1, cats: [], pinned: 0, importance: 0,
  ...over,
});

export const readingMessages = [
  row("m6", {
    from_name: "Noam Katz", from_email: "noam@example.org",
    subject: "דוח רבעוני לבדיקה", snippet: "שלום, מצורף הדוח הרבעוני. אשמח לשמוע מה דעתך לפני הפגישה ביום ראשון.",
    date: now - 40 * 60000, unread: 1,
  }),
  row("m7", {
    from_name: "ليلى حداد", from_email: "layla@example.net",
    subject: "اجتماع يوم الخميس", snippet: "مرحبا، أود أن أؤكد موعد الاجتماع يوم الخميس في الساعة العاشرة صباحا.",
    date: now - 70 * 60000, unread: 1,
  }),
  row("m8", {
    from_name: "Samuel Brandt", from_email: "samuel@example.com",
    subject: "Quarterly figures", snippet: "Outlook rich text: the figures are attached inside winmail.dat.",
    date: now - 100 * 60000,
  }),
];

export const readingBodies = {
  m6: {
    // A plain-text message, in the one wrapper the server writes for those.
    html: `<div style="white-space:pre-wrap;word-break:break-word">שלום נועה,\n\nמצורף הדוח הרבעוני. אשמח לשמוע מה דעתך לפני הפגישה ביום ראשון.\nהמספרים בעמוד 3 עדיין זמניים.\n\nתודה,\nנועם</div>`,
    attachments: [],
  },
  m7: {
    html: `<div dir="rtl" style="text-align:right"><p>مرحبا،</p><p>أود أن أؤكد موعد الاجتماع يوم الخميس في الساعة العاشرة صباحا. سنراجع الميزانية وخطة الربع القادم.</p><ul><li>الميزانية</li><li>الجدول الزمني</li></ul><p>مع التحية،<br>ليلى</p></div>`,
    attachments: [],
  },
  m8: {
    html: `<div style="white-space:pre-wrap;word-break:break-word">Hi,\n\nThe figures are in the attachments. Outlook sent them as one winmail.dat.\n\nSamuel</div>`,
    attachments: [
      { filename: "winmail.dat", type: "application/ms-tnef", size: 41200, part: "2", encoding: "base64", cid: "" },
      { filename: "Quarterly report.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 30211, part: "2", encoding: "base64", cid: "", tnef: 0 },
      { filename: "scan.pdf", type: "application/pdf", size: 8810, part: "2", encoding: "base64", cid: "", tnef: 1 },
    ],
  },
};
