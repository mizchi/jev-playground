# GDPR and Castle: How We Help You Stay Compliant

The General Data Protection Regulation (GDPR) is one of the most significant pieces of privacy legislation in the world. Since it came into force in May 2018, it has reshaped how companies collect, store, and process personal data. For developers and product teams, it's not just a legal concern. It affects how you design systems, what data you log, and how you respond when users ask what you know about them.

At Castle, we process data on behalf of our customers to help detect account takeovers and protect users. That puts us squarely within the scope of GDPR. In this post, we'll give you a compact overview of the regulation, explain how Castle fits in as a data processor, and walk through the specific ways we help you meet your obligations.

## GDPR in a Nutshell

### It Reaches Beyond the EU

A common misconception is that GDPR only applies to European companies. In reality, its scope is much broader. GDPR applies to any organization that processes the personal data of individuals in the European Union, regardless of where the organization is based. If you offer goods or services to people in the EU, or monitor their behavior online, GDPR likely applies to you, even if your servers and headquarters are in San Francisco or Singapore.

### Enforcement Has Teeth

GDPR is enforced by data protection authorities in each EU member state, and they have real power. Fines can reach up to €20 million or 4% of a company's global annual turnover, whichever is higher. These aren't theoretical numbers. Regulators have issued headline-making fines against major technology companies, including penalties in the hundreds of millions of euros, along with many smaller fines against businesses of all sizes.

Beyond fines, regulators can order companies to stop processing data altogether, which can be even more disruptive than a financial penalty.

### Personal Data Is Broader Than You Think

GDPR defines personal data as any information relating to an identified or identifiable natural person. That definition is intentionally broad.

Obvious examples include names, email addresses, and phone numbers. But personal data also includes indirect identifiers, pieces of information that on their own may not identify someone but can do so when combined with other data. Examples include:

- IP addresses
- Device identifiers
- Cookie IDs
- Location data
- Browser fingerprints
- Behavioral data tied to a user account

For a security product like Castle, which relies on signals like device information, IP addresses, and login behavior, this matters a lot. Much of the data used to detect suspicious activity qualifies as personal data under GDPR.

## Castle's Privacy-by-Design Approach

GDPR requires organizations to implement data protection by design and by default. At Castle, we've built our platform with privacy in mind from the ground up.

That means we collect only the data necessary to detect threats and protect accounts, secure it with strong technical and organizational safeguards, and limit how long it's retained. We treat user data as something entrusted to us by our customers, not as an asset to exploit. We don't sell it, and we don't use it for purposes beyond providing our service.

## Controllers and Processors

GDPR distinguishes between two key roles:

- **Data controller:** The organization that determines the purposes and means of processing personal data. In most cases, that's you, our customer. You decide what data to collect from your users and why.
- **Data processor:** An organization that processes personal data on behalf of a controller. That's Castle. We process data according to your instructions to provide account security services.

As a controller, you're ultimately responsible for complying with GDPR and responding to your users' rights. As a processor, Castle is obligated to support you in meeting those obligations, process data only on your documented instructions, and maintain appropriate security measures. We formalize this relationship through a Data Processing Agreement (DPA).

## Where Castle Helps

### Data Access Requests

Under GDPR, individuals have the right to access the personal data an organization holds about them. When one of your users submits a data subject access request, you need to be able to gather the relevant information, including data held by your processors.

Castle makes it easy to retrieve the data we hold about a specific user, such as their devices, login history, and associated events. This allows you to include Castle-related data in your response without manual digging.

### Erasure Requests

GDPR also gives individuals the right to erasure, often called the "right to be forgotten." When a user asks you to delete their data, that request extends to data held by your processors.

Castle provides dedicated API endpoints that allow you to delete all data associated with a specific user. You can integrate these endpoints directly into your existing deletion workflows, so when a user deletes their account or submits an erasure request, their data is removed from Castle as well. No support tickets, no manual processes.

### Breach Notification

GDPR requires controllers to notify the relevant supervisory authority of a personal data breach within 72 hours of becoming aware of it, and in some cases, to notify affected individuals as well. Meeting that timeline requires fast detection.

This is an area where Castle's core product shines. Our real-time anomaly detection surfaces suspicious activity as it happens, including unusual login patterns, credential stuffing attacks, and signs of compromised accounts. Real-time alerts help your team identify potential incidents quickly, understand their scope, and take action, giving you the visibility you need to meet your notification obligations.

## Our Commitment to Privacy

Protecting user accounts and protecting user privacy go hand in hand. We believe security tools should make the internet safer without compromising the rights of the people they protect. GDPR has helped set a higher standard for how personal data is handled, and we're committed to meeting and exceeding it.

We'll continue to evolve our platform as privacy regulations and best practices develop. If you have questions about how Castle handles data, need a copy of our DPA, or have ideas for how we can better support your compliance efforts, we'd love to hear from you. Reach out to our team anytime.
