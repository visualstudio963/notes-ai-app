const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const {
  findOrLinkGoogleUser,
  upsertGoogleUserFromIdTokenPayload
} = require("../routes/auth.routes");

const SERIALIZE_PENDING = "GOOGLE_SIGNUP_PENDING";

/**
 * @param {object} deps
 * @param {import("mongoose").Model} deps.User
 * @param {string} deps.googleClientId
 * @param {string} deps.googleClientSecret
 * @param {string} deps.googleCallbackUrl
 */
function configurePassport(deps) {
  const { User, googleClientId, googleClientSecret, googleCallbackUrl } = deps;

  const cleanId = String(googleClientId || "").trim();
  const cleanSecret = String(googleClientSecret || "").trim();
  const cleanCallback = String(googleCallbackUrl || "").trim();

  if (!cleanId || !cleanSecret || !cleanCallback) {
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: cleanId,
        clientSecret: cleanSecret,
        callbackURL: cleanCallback,
        passReqToCallback: true
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const emailRaw =
            profile.emails && profile.emails[0] && profile.emails[0].value
              ? String(profile.emails[0].value).trim().toLowerCase()
              : "";
          if (!emailRaw) {
            return done(new Error("Google did not return an email address"));
          }
          const sub = String(profile.id || "").trim();
          if (!sub) {
            return done(new Error("Google did not return a user id"));
          }
          const pic =
            profile.photos && profile.photos[0] && profile.photos[0].value
              ? String(profile.photos[0].value).trim()
              : "";

          const existing = await findOrLinkGoogleUser(User, {
            sub,
            email: emailRaw,
            name: String(profile.displayName || "").trim(),
            picture: pic
          });

          if (existing) {
            return done(null, existing);
          }

          try {
            const user = await upsertGoogleUserFromIdTokenPayload(
              User,
              {
                sub,
                email: emailRaw,
                name: String(profile.displayName || "").trim()
              },
              ""
            );
            if (pic && user && user._id) {
              await User.updateOne({ _id: user._id }, { $set: { googlePicture: pic } });
            }
            const fresh = await User.findById(user._id);
            return done(null, fresh);
          } catch (geoErr) {
            return done(geoErr);
          }
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user, done) => {
    if (user && user.isPending) {
      return done(null, SERIALIZE_PENDING);
    }
    if (!user || !user._id) {
      return done(new Error("Invalid user to serialize"));
    }
    done(null, user._id.toString());
  });

  passport.deserializeUser(async (sid, done) => {
    try {
      if (sid === SERIALIZE_PENDING) {
        return done(null, { isPending: true });
      }
      const user = await User.findById(sid);
      done(null, user);
    } catch (e) {
      done(e);
    }
  });
}

module.exports = { configurePassport, passport, SERIALIZE_PENDING };
