// src/lib/auth.ts
// NextAuth configuration

import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import AppleProvider from 'next-auth/providers/apple';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { gameAdapter } from './authAdapter';

// Re-exported for the callers that already import it from here.
export { randomAvatar } from './avatars';

/** True when both of a provider's env vars are present and non-empty. */
const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const appleEnabled = Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET);

// Mirrors NextAuth's own check: cookies get the `__Secure-` prefix and the
// Secure attribute only on an https deployment.
const useSecureCookies = (process.env.NEXTAUTH_URL ?? '').startsWith('https://');

export const authOptions: NextAuthOptions = {
  adapter: gameAdapter(prisma) as any,
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/login',
    // Every OAuth error lands back on /login, which reads `?error=` and says
    // something a player can act on. Without this NextAuth renders its own
    // unstyled error page.
    error: '/login',
    newUser: '/signup',
  },
  providers: [
    // Email / Password
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user || !user.password) return null;

        const passwordMatch = await bcrypt.compare(credentials.password, user.password);
        if (!passwordMatch) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.avatar,
        };
      },
    }),

    // Google OAuth (optional — only active if env vars set)
    ...(googleEnabled
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            // Always show the chooser. Households share a machine and a
            // player who wants a second account otherwise gets silently
            // signed back into the first one.
            authorization: {
              params: { prompt: 'select_account' },
            },
          }),
        ]
      : []),

    // Apple OAuth (optional) — the third provider spec §11 asks for, alongside
    // email and Google. Discord is a "later" in that section, not a launch
    // provider, so it is deliberately gone rather than sitting beside these.
    //
    // Unlike Google, APPLE_CLIENT_SECRET is not a static string: Apple wants a
    // ES256 JWT signed with the private key from your developer account, and it
    // expires after at most 6 months. Regenerating it is an ops chore, not a
    // one-time setup — see .env.example.
    ...(appleEnabled
      ? [
          AppleProvider({
            clientId: process.env.APPLE_CLIENT_ID!,
            clientSecret: process.env.APPLE_CLIENT_SECRET!,
          }),
        ]
      : []),
  ],

  // Apple returns with `response_mode=form_post`: the browser POSTs to
  // /api/auth/callback/apple from appleid.apple.com, which is a cross-site
  // request, so a SameSite=Lax cookie is not sent. The PKCE verifier Apple's
  // provider config requires is exactly such a cookie, and its absence is the
  // classic "OAuthCallback / pkce code_verifier cookie was missing" failure.
  //
  // Only relaxed when Apple is actually configured, and only on https —
  // SameSite=None without Secure is rejected outright by browsers, so on a
  // local http host we leave the defaults alone and Apple stays untestable
  // there (which it is anyway: Apple refuses to register an http redirect).
  ...(appleEnabled && useSecureCookies
    ? {
        cookies: {
          // Not a security cookie — it holds this site's own post-login URL,
          // and NextAuth's redirect callback still rejects anything
          // off-origin. Left at Lax it simply isn't sent on Apple's POST, and
          // the player lands on / instead of the dashboard they came from.
          callbackUrl: {
            name: '__Secure-next-auth.callback-url',
            options: {
              httpOnly: true,
              sameSite: 'none' as const,
              path: '/',
              secure: true,
            },
          },
          pkceCodeVerifier: {
            name: '__Secure-next-auth.pkce.code_verifier',
            options: {
              httpOnly: true,
              sameSite: 'none' as const,
              path: '/',
              secure: true,
              maxAge: 60 * 15,
            },
          },
          state: {
            name: '__Secure-next-auth.state',
            options: {
              httpOnly: true,
              sameSite: 'none' as const,
              path: '/',
              secure: true,
              maxAge: 60 * 15,
            },
          },
          nonce: {
            name: '__Secure-next-auth.nonce',
            options: {
              httpOnly: true,
              sameSite: 'none' as const,
              path: '/',
              secure: true,
            },
          },
        },
      }
    : {}),

  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id;
        // `user` is the credentials `authorize()` return on one path and the
        // adapter's row on the other, so the emoji arrives under `image` or
        // under `avatar` depending on which. Normalising here is what makes
        // `session.user.image` an emoji for every provider — the room page
        // feeds it straight to the socket server as the player's avatar.
        const avatar = (user as any).avatar ?? user.image;
        if (avatar) token.picture = avatar;
        if (user.name) token.name = user.name;
      }

      // /profile calling useSession().update() after a successful save. The
      // session is a JWT, so the database row is never re-read on a later
      // request — without this the token keeps the old name and character
      // until it expires, and the header chip, the lobby and the socket join
      // would all go on using them. Deliberately *not* a place to trust the
      // client: the values are re-derived from the row the API just wrote, and
      // /api/profile has already vetted them against the roster and the length
      // bounds. Nothing else on the token is writable from here.
      if (trigger === 'update' && session) {
        const patch = session as { name?: unknown; picture?: unknown };
        if (typeof patch.name === 'string') token.name = patch.name;
        if (typeof patch.picture === 'string') token.picture = patch.picture;
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        (session.user as any).id = token.id;
        session.user.image = (token.picture as string | undefined) ?? session.user.image;
        session.user.name = (token.name as string | undefined) ?? session.user.name;
      }
      return session;
    },
  },
};
