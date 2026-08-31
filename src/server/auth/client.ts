"use client";

import { createAuthClient } from "better-auth/react";

// baseURL defaults to the current origin, which is what we want in-app.
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
