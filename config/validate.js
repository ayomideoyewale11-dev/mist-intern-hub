const mongoose = require("mongoose");
const { isIP } = require("node:net");

const validId = (id) => mongoose.isValidObjectId(id);
const validEmail = (value) => {
  if (typeof value !== "string") return false;
  const email = value.trim();
  if (email.length > 254) return false;
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (
    local.length > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) return false;
  const labels = domain.split(".");
  return labels.length > 1 && labels.every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
};
const validDate = (d) => {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const date = new Date(`${d}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === d;
};
const MAX_BCRYPT_PASSWORD_BYTES = 72;
const validNewPassword = (password) =>
  typeof password === "string" &&
  password.length >= 8 &&
  Buffer.byteLength(password, "utf8") <= MAX_BCRYPT_PASSWORD_BYTES;
const passwordFitsBcrypt = (password) =>
  typeof password === "string" &&
  Buffer.byteLength(password, "utf8") <= MAX_BCRYPT_PASSWORD_BYTES;
const isHttpUrl = (u) => {
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};
const isPublicHttpsUrl = (value) => {
  try {
    const url = new URL(value);
    const labels = url.hostname.split(".");
    const publicTld = (label) => /^[a-z]{2,63}$/i.test(label) || /^xn--[a-z0-9-]{2,59}$/i.test(label);
    return url.protocol === "https:" &&
      Boolean(url.hostname) &&
      labels.length >= 2 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)) &&
      publicTld(labels.at(-1)) &&
      isIP(url.hostname) === 0 &&
      !/\.(?:invalid|test|example|localhost|local|internal|onion)$/i.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.hostname !== "localhost" &&
      !url.hostname.endsWith(".localhost") &&
      !url.hostname.endsWith(".local");
  } catch {
    return false;
  }
};

module.exports = {
  validId,
  validEmail,
  validDate,
  validNewPassword,
  passwordFitsBcrypt,
  MAX_BCRYPT_PASSWORD_BYTES,
  isHttpUrl,
  isPublicHttpsUrl,
};
