# Certificate rotation procedure

Edge certificates are rotated thirty days before expiry using the staged issuer.

## Issuing the new certificate

The issuer job requests a certificate for every hostname in the inventory and stores it beside the current one.

## Switching traffic

Traffic moves to the new certificate during a quiet window, and the old one stays loaded for one day as a fallback.
