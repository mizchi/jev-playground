# GDPR and Castle: How We Help You Stay Compliant

The General Data Protection Regulation (GDPR) ranks among the world's most important privacy laws. Since taking effect in May 2018, it has changed how companies collect, store, and process personal data. Developers and product teams can't leave it to the lawyers: it shapes how you design systems, what data you log, and how you answer users who ask what you know about them.

Castle processes data on behalf of our customers to detect account takeovers and protect users, which places us firmly within GDPR's scope. This post gives a short overview of the regulation, explains Castle's role as a data processor, and describes the specific ways we help you meet your obligations.

## GDPR in a Nutshell

### It Reaches Beyond the EU

Many people assume GDPR covers only European companies, but its reach is much wider. It applies to any organization, wherever it is based, that processes the personal data of individuals in the European Union. If you offer goods or services to people in the EU or monitor their behavior online, GDPR probably applies to you, even with your servers and headquarters in San Francisco or Singapore.

### Enforcement Has Teeth

Data protection authorities in each EU member state enforce GDPR, and their powers are substantial. Fines can reach €20 million or 4% of a company's global annual turnover, whichever is higher. Regulators have actually imposed penalties at this scale: they have fined major technology companies hundreds of millions of euros in cases that made headlines, and they have issued many smaller fines against businesses of every size.

Regulators can also order a company to stop processing data entirely, which can disrupt a business even more than a fine.

### Personal Data Is Broader Than You Think

GDPR defines personal data as any information relating to an identified or identifiable natural person, and the definition is deliberately broad.

Names, email addresses, and phone numbers are the obvious cases. Personal data also covers indirect identifiers: information that may not identify someone by itself but can when combined with other data. These include:

- IP addresses
- Device identifiers
- Cookie IDs
- Location data
- Browser fingerprints
- Behavioral data tied to a user account

This is especially relevant for a security product like Castle, which depends on device information, IP addresses, and login behavior. Much of the data we use to spot suspicious activity counts as personal data under GDPR.

## Castle's Privacy-by-Design Approach

GDPR requires organizations to build in data protection by design and by default. Castle's platform was designed with privacy in mind from the start.

In practice, we collect only the data needed to detect threats and protect accounts, protect it with strong technical and organizational safeguards, and limit how long we keep it. Our customers entrust their users' data to us, and we don't treat it as an asset to exploit. We don't sell it, and we use it only to provide our service.

## Controllers and Processors

GDPR defines two key roles:

- **Data controller:** The organization that decides the purposes and means of processing personal data. Usually that's you, our customer: you choose what data to collect from your users and why.
- **Data processor:** An organization that processes personal data on a controller's behalf. That's Castle. We process data according to your instructions in order to provide account security services.

As the controller, you bear ultimate responsibility for GDPR compliance and for honoring your users' rights. As the processor, Castle must help you meet those obligations, process data only on your documented instructions, and maintain appropriate security measures. A Data Processing Agreement (DPA) formalizes this relationship.

## Where Castle Helps

### Data Access Requests

GDPR gives individuals the right to access the personal data an organization holds about them. When one of your users files a data subject access request, you must collect the relevant information, including data your processors hold.

Castle lets you easily retrieve the data we hold on a specific user, such as their devices, login history, and associated events, so you can add it to your response without searching by hand.

### Erasure Requests

Individuals also have the right to erasure under GDPR, often called the "right to be forgotten." A user's request to delete their data covers data held by your processors too.

Castle offers dedicated API endpoints for deleting all data associated with a specific user. You can plug them straight into your existing deletion workflows, so that when a user deletes their account or submits an erasure request, Castle removes their data as well, without support tickets or manual steps.

### Breach Notification

Under GDPR, controllers must notify the relevant supervisory authority of a personal data breach within 72 hours of learning of it and, in some cases, must notify affected individuals too. Hitting that deadline depends on detecting the breach quickly.

Castle's core product is built for exactly this. Our real-time anomaly detection flags suspicious activity as it occurs, including unusual login patterns, credential stuffing attacks, and signs of compromised accounts. Real-time alerts help your team spot potential incidents fast, gauge their scope, and respond, giving you the visibility you need to meet your notification obligations.

## Our Commitment to Privacy

Protecting user accounts and protecting user privacy belong together. Security tools should make the internet safer without undermining the rights of the people they protect. GDPR has raised the bar for handling personal data, and we intend to meet and exceed it.

We will keep updating our platform as privacy regulations and best practices change. If you have questions about how Castle handles data, need a copy of our DPA, or have ideas for better supporting your compliance work, please contact our team at any time.
