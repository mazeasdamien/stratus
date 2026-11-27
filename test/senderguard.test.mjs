/**
 * Sender warnings (public/senderguard.js) against a table of real-world
 * shaped senders. The benign half matters as much as the hostile half: every
 * false alarm is a reason to stop reading the bar.
 */
import { eq, ok } from "./harness.mjs";
import { registrable, senderWarnings } from "../public/senderguard.js";

const kinds = (name, email) => senderWarnings(name, email).map((w) => w.kind);

// What a real company, a newsletter and a person look like: nothing to say.
const BENIGN = [
  ["Apple", "no_reply@email.apple.com"],
  ["Apple Developer", "developer@insideapple.apple.com"],
  ["Apple", "noreply@apple.com"],
  ["Amazon Web Services", "no-reply-aws@amazon.com"],
  ["AWS Notifications", "no-reply@sns.amazonaws.com"],
  ["Amazon", "auto-confirm@amazon.fr"],
  ["Amazon.fr", "commandes@amazon.fr"],
  ["Amazon", "shipment-tracking@amazon.co.uk"],
  ["PayPal", "service@paypal.fr"],
  ["PayPal", "service@mail.paypal.com"],
  ["Microsoft account team", "account-security-noreply@accountprotection.microsoft.com"],
  ["Microsoft", "microsoft-noreply@microsoft.com"],
  ["Google", "no-reply@accounts.google.com"],
  ["Google Calendar", "calendar-notification@google.com"],
  ["Netflix", "info@mailer.netflix.com"],
  ["LinkedIn", "messages-noreply@linkedin.com"],
  ["Zoom", "no-reply@zoom.us"],
  ["DHL Express", "noreply@dhl.com"],
  ["La Poste", "ne-pas-repondre@laposte.fr"],
  // A "via" service names a person, not the brand.
  ["Camille via Substack", "no-reply@substack.com"],
  ["Jane Doe via LinkedIn", "messages-noreply@linkedin.com"],
  ["Léa (via Google Drive)", "drive-shares-noreply@google.com"],
  // A name that happens to contain a brand word.
  ["Amazonia Travel", "hello@amazonia-travel.test"],
  ["Dr. Apple", "drapple@clinic.test"],
  ["Apple Hospitality REIT", "ir@applereit.test"],
  ["Orange County Library", "desk@ocl.test"],
  ["Paypal Fan Club of Lyon", "club@fans.test"],
  ["John Zoom", "john@zoomwork.test"],
  // Ordinary people and companies.
  ["Camille Roux", "camille@atelier-roux.test"],
  ["Studio Dupont", "contact@studio-dupont.test"],
  ["", "alone@example.test"],
  // A name that is an address, and is the sender's.
  ["alice@acme.test", "alice@acme.test"],
  ["billing@acme.test", "noreply@acme.test"],
  ["acme.test", "hello@mail.acme.test"],
  // Domains that are merely near a short brand.
  ["Ample Works", "hi@ample.test"],
  ["Maples", "hi@apples.test"],
];
for (const [name, email] of BENIGN) eq(kinds(name, email), [], `no warning for ${JSON.stringify(name)} <${email}>`);

// The three things worth a bar.
const HOSTILE = [
  ["PayPal", "service@paypa1.com", ["brand-name", "lookalike-domain"]],
  ["PayPal Security", "security@gmail.com", ["brand-name"]],
  ["Microsoft Account Team", "no-reply@outlook.com", ["brand-name"]],
  ["Apple Support", "support@icloud.com", ["brand-name"]],
  ["Apple ID", "appleid@secure-apple.test", ["brand-name"]],
  ["Amazon", "orders@amazon-orders.xyz", ["brand-name"]],
  ["Netflix", "billing@netfllx.com", ["brand-name", "lookalike-domain"]],
  ["DHL Express", "info@dhl-delivery.top", ["brand-name"]],
  ["Google Security Alert", "no-reply@gooogle.com", ["brand-name", "lookalike-domain"]],
  ["Microsoft", "support@rnicrosoft.com", ["brand-name", "lookalike-domain"]],
  ["LinkedIn", "notifications@linkedin.com.evil.test", ["brand-name"]],
  ["Amazon", "x@amazon.tk", ["brand-name", "lookalike-domain"]],
  ["Alice", "alice@pay-pal.com", ["lookalike-domain"]],
  ["Bob", "bob@micros0ft.net", ["lookalike-domain"]],
  ["Chris", "chris@arnazon.com", ["lookalike-domain"]],
  ["Dan", "dan@goggle.com", ["lookalike-domain"]],
  ["support@paypal.com", "x@evil.test", ["name-is-address"]],
  ["https://www.apple.com", "x@evil.test", ["name-is-address"]],
  ["paypal.com", "x@evil.test", ["brand-name", "name-is-address"]],
];
for (const [name, email, want] of HOSTILE) eq(kinds(name, email), want, `warns about ${JSON.stringify(name)} <${email}>`);

// The words carry the real address.
const w = senderWarnings("PayPal Security", "security@gmail.com")[0];
ok(w.text.includes("security@gmail.com") && w.text.includes("PayPal"), `the sentence names the brand and the real address — ${w.text}`);
ok(senderWarnings("PayPal", "x@paypa1.com").every((x) => x.text.includes("x@paypa1.com")), "every sentence shows the address it is about");

// No address, nothing to compare.
eq(senderWarnings("PayPal", ""), [], "no address, no warning");

// The registrable part of a host.
eq(registrable("mail.amazon.co.uk"), { sld: "amazon", tld: "co.uk", domain: "amazon.co.uk" }, "a second-level suffix is kept");
eq(registrable("a.b.paypal.fr").domain, "paypal.fr", "subdomains are dropped");
