# Email Intelligence public proxy (n8n)

Service is a separate ECS microservice. External tools use the Skout API proxy.

**POST** `https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com/api/v1/email-intel/verify`

Headers: `Content-Type: application/json` and `x-api-key: $EMAIL_INTEL_EXTERNAL_API_KEY`

Body: `{ "email": "sailish@skoutai.io" }`

Internal DNS (VPC only): `http://email-intel.skoutdev.local:3001/verify`

Set `EMAIL_INTEL_EXTERNAL_API_KEY` on the API task (Secrets Manager) before sharing the key with n8n.
