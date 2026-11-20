# Credentials

## Where keys live

Backend credentials (LightRAG sole) live only in the server env file and are referenced
by name. No command in the documentation prints a credential value.

## What the redactor does

A pasted key such as sk-proj-abcdefghij1234567890 must never reach a
reply: the redactor replaces it before any citation is returned, and a
golden fixture asserts that the placeholder above never appears in one.
