function base64urlToBuffer(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function bufferToBase64url(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function prepareCreationOptions(options) {
  options.challenge = base64urlToBuffer(options.challenge);
  options.user.id = base64urlToBuffer(options.user.id);
  options.excludeCredentials = (options.excludeCredentials || []).map((credential) => ({
    ...credential,
    id: base64urlToBuffer(credential.id),
  }));
  return options;
}

function prepareRequestOptions(options) {
  options.challenge = base64urlToBuffer(options.challenge);
  options.allowCredentials = (options.allowCredentials || []).map((credential) => ({
    ...credential,
    id: base64urlToBuffer(credential.id),
  }));
  return options;
}

function credentialToJSON(credential) {
  const response = {
    clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
  };
  if (credential.response.attestationObject) {
    response.attestationObject = bufferToBase64url(credential.response.attestationObject);
    response.transports = credential.response.getTransports?.() || [];
  } else {
    response.authenticatorData = bufferToBase64url(credential.response.authenticatorData);
    response.signature = bufferToBase64url(credential.response.signature);
    response.userHandle = credential.response.userHandle
      ? bufferToBase64url(credential.response.userHandle)
      : null;
  }
  return {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response,
  };
}

function assertPasskeyContext(options) {
  if (!window.isSecureContext) {
    throw new Error(
      "Passkey работает только через HTTPS. Для локальной разработки откройте http://localhost, а не адрес сервера по сети."
    );
  }
  const rpId = options.rp?.id || options.rpId;
  if (rpId && location.hostname !== rpId && !location.hostname.endsWith(`.${rpId}`)) {
    throw new Error(
      `Домен страницы (${location.hostname}) не соответствует WebAuthn RP ID (${rpId}). ` +
      "Исправьте TASKA_WEBAUTHN_RP_ID и TASKA_WEBAUTHN_ORIGIN."
    );
  }
}

function passkeyErrorMessage(error) {
  if (error?.name === "SecurityError" || error?.message === "The operation is insecure.") {
    return "Браузер заблокировал passkey: нужен HTTPS и точное совпадение домена с WebAuthn RP ID.";
  }
  if (error?.name === "NotAllowedError") {
    return "Операция отменена или устройство не разрешило использование passkey.";
  }
  return error?.message || "Не удалось выполнить операцию с passkey";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Ошибка passkey");
  return data;
}

async function loginWithPasskey(button) {
  button.disabled = true;
  try {
    const options = await api("/auth/passkey/login/options", { method: "POST" });
    assertPasskeyContext(options);
    const credential = await navigator.credentials.get({
      publicKey: prepareRequestOptions(options),
    });
    await api("/auth/passkey/login/verify", {
      method: "POST",
      body: JSON.stringify({ credential: credentialToJSON(credential) }),
    });
    window.location.assign("/");
  } catch (error) {
    document.querySelector("[data-passkey-error]").textContent = passkeyErrorMessage(error);
    button.disabled = false;
  }
}

async function registerPasskey(button) {
  button.disabled = true;
  try {
    const options = await api("/auth/passkey/register/options", { method: "POST" });
    assertPasskeyContext(options);
    const credential = await navigator.credentials.create({
      publicKey: prepareCreationOptions(options),
    });
    const name = window.prompt("Название устройства", "Мой passkey") || "Passkey";
    await api("/auth/passkey/register/verify", {
      method: "POST",
      body: JSON.stringify({ credential: credentialToJSON(credential), name }),
    });
    window.location.reload();
  } catch (error) {
    document.querySelector("[data-passkey-error]").textContent = passkeyErrorMessage(error);
    button.disabled = false;
  }
}

async function deletePasskey(id) {
  if (!window.confirm("Удалить этот passkey?")) return;
  try {
    await api(`/auth/passkey/${id}`, { method: "DELETE" });
    window.location.reload();
  } catch (error) {
    document.querySelector("[data-passkey-error]").textContent = passkeyErrorMessage(error);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const supported = Boolean(window.PublicKeyCredential && navigator.credentials);
  document.querySelectorAll("[data-passkey-login]").forEach((button) => {
    button.hidden = !supported;
    button.addEventListener("click", () => loginWithPasskey(button));
  });
  document.querySelectorAll("[data-passkey-register]").forEach((button) => {
    button.hidden = !supported;
    button.addEventListener("click", () => registerPasskey(button));
  });
  document.querySelectorAll("[data-passkey-delete]").forEach((button) => {
    button.addEventListener("click", () => deletePasskey(button.dataset.passkeyDelete));
  });
});
