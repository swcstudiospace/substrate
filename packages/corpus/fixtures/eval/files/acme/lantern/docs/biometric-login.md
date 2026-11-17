# Biometric login flow

Fingerprint and face unlock protect a refresh token that is stored in the secure enclave.

## Enrolment

The user enables biometrics after a password login and the app stores a key that only the enclave can use.

## Fallback to password

After three failed biometric attempts the app asks for the password and clears the stored key.
