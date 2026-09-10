# SAML Assertion Inspector

A CAP Node.js tool for inspecting the SAML assertion that the SAP BTP Destination Service builds on behalf of a logged-in user. You enter a destination name, click a button, and the tool shows you the decoded XML — including the `<saml:NameID>` and every attribute inside the assertion.

---

## Why this tool exists

This project was built to investigate a customer issue in which a CAP application on SAP BTP could not retrieve SuccessFactors  data for users with **concurrent employments**. Users with a single employment worked fine. The inconsistency pointed to an identity resolution problem at the SuccessFactors side.

The root cause turned out to be a chain of four related issues:

| # | Problem |
|---|---------|
| 1 | `nameIdFormat` was set to `emailAddress` in the destination. SuccessFactors requires the **user ID** (not email) when a user has concurrent employments, because email is ambiguous across them. |
| 2 | The CAP application's JWT did not contain the SuccessFactors user id — it was only populated with email-based claims from the Azure IdP. |
| 3 | The `user_attributes` scope was missing from the token. Without it, the Destination Service cannot call back to XSUAA to retrieve the user's custom attributes, even if those attributes are declared. |
| 4 | The `userIdSource` JSONPath used the wrong path. It referenced `$['xs.user.attributes']['ec_userid'][0]` (the field as it appears in the raw JWT payload) instead of `$['user_attributes']['ec_userid'][0]` (the field as returned by the XSUAA `/userinfo` endpoint, which is what the Destination Service actually reads). |

The fix required all four issues to be resolved together. This tool was written to make the SAML assertion **visible** at each step, so you can confirm whether a change actually had the expected effect before moving on.

### Why custom attributes were the right path

When we inspected the CAP application's JWT, every identity claim in it was email-based... `user_name`, `email`... all resolved to the same email address. The token was largely shaped by the Azure IdP upstream, so modifying the root-level claims was not a viable option without touching IdP configuration that was outside the customer's control.

The Destination Service resolves the SAML `NameID` from the token using one of two paths:

1. **A direct JWT field**: it reads a claim straight from the token payload. If every claim in the token is email-based, this path has no way to produce a user ID.
2. **The Custom User Attribute source**: it uses the token as a credential to call the XSUAA `/userinfo` endpoint and reads per-user attributes from there. These attributes are provisioned independently of the root IdP claims, via `xs-security.json` and BTP Trust Configuration.

Since modifying the IdP-issued root claims was not an option we decided provision a custom attribute in XSUAA (declared in `xs-security.json`, mapped to the IAS attribute via Trust Configuration), and configure the destination's `userIdSource` to read from the XSUAA attribute response. That way, the SAML assertion is built with the SuccessFactors user ID regardless of what the IdP originally put in the token.

---

## What the tool does

The single action — **Via Token Exchange** — does the following:

1. Takes the user's JWT from the incoming request (the XSUAA session cookie set by the approuter).
2. Calls `getDestination({ destinationName, jwt })` from the SAP Cloud SDK. This triggers a token exchange: XSUAA issues a new token scoped to the Destination Service, and the Destination Service uses it to build the SAML assertion.
3. Returns the Base64-encoded assertion from `destination.authTokens[0]`.
4. Decodes it and displays the raw XML.

You can then read the `<saml:NameID>` value and the `<saml:Attribute>` elements directly. There is no guessing involved.

---

## How `xs-security.json` fits in

The `xs-security.json` enables the custom attribute flow that was missing in the customer's application:

```json
{
  "attributes": [
    { "name": "ec_userid",  "valueType": "string" }
  ],
  "role-templates": [{
    "name": "User",
    "attribute-references": ["ec_userid"]
  }],
  "foreign-scope-references": ["user_attributes"]
}
```

- **`attributes`** declares which IdP attributes XSUAA should accept and expose per-user.
- **`attribute-references`** in the role template binds those attributes to a role, so they are only populated when the user holds that role collection.
- **`foreign-scope-references: ["user_attributes"]`** makes XSUAA to include the `user_attributes` scope in the token. Without this scope, the Destination Service's Custom User Attribute source returns an error and cannot read the proper Custom User Property from the XSUAA userinfo response.

For the fix to work end-to-end, you also need:

1. The IdP attributes mapped in **BTP Cockpit → Security → Trust Configuration** (e.g. `ec_userid` → `employeeId` from IAS).
2. The user assigned the **SAML Inspector User** role collection so that those attribute mappings are active for them.

---

## Destination configuration that matches this flow

To reproduce the working state (user ID propagation, not email):

Note here... We are using SAMLAssertion, because the determination of the NameId in the SAML is a logic shared with OauthBearerSamlAssertion destination type that you will use to set up SSFF. In my case, I do not have a SSFF instance, but since the issue was raising at destination level, and not at SSFF level, SAMLAssertion destination type is enough for this analysis.

| Property | Value |
|----------|-------|
| Authentication | `SAMLAssertion` |
| `nameIdFormat` | `urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified` |
| `userIdSource` | `$['user_attributes']['ec_userid'][0]` |

The `userIdSource` JSONPath path must reference `user_attributes`, not `xs.user.attributes`. The former is the key used in the XSUAA `/userinfo` response; the latter is how it appears embedded in the raw JWT payload. The Destination Service reads from the `/userinfo` response.

---

## Setup

### 1. Create a SAMLAssertion destination in BTP Cockpit

Navigate to your subaccount → **Connectivity → Destinations → New Destination**.

| Field | Value |
|-------|-------|
| Name | Any name (you will type it into the tool's input field) |
| Type | `HTTP` |
| URL | Any placeholder URL — it is not called during assertion inspection |
| Authentication | `SAMLAssertion` |
| Audience | The SAML SP entity ID of your target system |
| `nameIdFormat` | `urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified` |
| `userIdSource` | `$['user_attributes']['ec_userid'][0]` (or whichever attribute you want to test) |

### 2. Map IdP attributes in Trust Configuration

In your subaccount → **Security → Trust Configuration → your IdP → Attributes**, add:

| User Attribute | Identity Provider Attribute |
|----------------|-----------------------------|
| `email` | `mail` (or your IdP's email attribute) |
| `logonName` | `logonName` |
| `ec_userid` | `employeeId` (or whatever the IAS attribute is named in your tenant) |

The left column must exactly match the `name` fields declared in `xs-security.json`.

### 3. Assign the role collection to your test user

`xs.user.attributes` is only populated for users who hold a role collection that references the declared attributes. Without this, the attributes array in the token is empty.

1. BTP Cockpit → subaccount → **Security → Role Collections**.
2. Find **SAML Inspector User**.
3. Edit → Users → Add User → enter the test user's email → Save.

### 4. Deploy to Cloud Foundry

Prerequisites: [MBT](https://sap.github.io/cloud-mta-build-tool/) and [CF CLI](https://docs.cloudfoundry.org/cf-cli/) installed and authenticated.

```sh
npm install -g mbt   # if not already installed
mbt build
cf deploy mta_archives/*.mtar
```

Open the approuter URL after deployment. The approuter handles the XSUAA login and sets the session cookie.

---

## Reading the output

Once you click **Via Token Exchange**, examine the **Decoded XML** tab:

```xml
<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">
  12345678
</saml:NameID>
```

---

## Key takeaways

- **Validate the NameID format before touching any code.** For SuccessFactors concurrent employment scenarios, the assertion must carry the SuccessFactors user ID — not the email address.
- **`xs.user.attributes` in the JWT and the XSUAA `/userinfo` response are different things.** The JSONPath in `userIdSource` must use `$['user_attributes']['ec_userid'][0]`, not `$['xs.user.attributes']['ec_userid'][0]`. The Destination Service reads from `/userinfo`, not from the token payload.

NOTE: We are using `$['user_attributes']['ec_userid'][0]` because the token used by the SAP Cloud SDK is the one raised by XSUAA for the destination service, considering the initial token of the CAP application. Meaning that when the token of the destination service is built and then used for retrieving the destination with the SAML, the token of the destination service with the embedded user details is used. NO X-USER-TOKEN header is used. It is used the Authorization header against the destination service. That is why, since the 'user_attrbitues' scope is in the token, the destination service knows that a call against XSUAA should be done to retrieve custom params. If by any chance you are retrieving destinations with the APIs of the destination service explained in the business accelerator hub, and using the X-user-token header, you can use the `$['xs.user.attributes']['ec_userid'][0]`.

- **`user_attributes` is a required scope for the Custom User Attribute source.** Add `"foreign-scope-references": ["user_attributes"]` to `xs-security.json`. This is not documented prominently but is a hard requirement.
- **Attributes are only live for users with the right role collection.** Declaring attributes in `xs-security.json` is not enough. The user must hold a role collection whose role template references those attributes, and the IdP must have the corresponding mappings active.
- **`xs.user.attributes` will be empty in the token after the `jwt-bearer` exchange.** This is expected behavior. It does not prevent the Custom User Attribute source from working because the Destination Service uses the `/userinfo` endpoint, not the token payload, to read those attributes.

---

## References

- [Create and Consume Destination for Cloud Foundry Application](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/create-and-consume-destination-for-cloud-foundry-application)
- [User Propagation via SAML 2.0 Bearer Assertion Flow](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/user-propagation-via-saml-2-0-bearer-assertion-flow)
- [User Propagation from Cloud Foundry to SAP SuccessFactors](https://help.sap.com/docs/connectivity/sap-btp-connectivity-cf/user-propagation-from-cloud-foundry-environment-to-sap-successfactors)
