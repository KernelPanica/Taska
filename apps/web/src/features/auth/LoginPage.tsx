import { SignIn } from "@phosphor-icons/react";
import { useSearchParams } from "react-router-dom";
import { isErrorCode } from "../../api/client";
import { AppBar } from "../../components/AppBar";
import { LanguageSwitcher } from "../../components/LanguageSwitcher";
import { useI18n } from "../../i18n";

function loginHref(returnTo: string | null) {
  const params = new URLSearchParams();
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) params.set("returnTo", returnTo);
  return `/api/v1/auth/login${params.size ? `?${params}` : ""}`;
}

/** Вход только аккаунтом YourSpace: форма пароля — на стороне YourSpace (R-2.1). */
export function LoginPage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const error = params.get("error");
  const returnTo = params.get("returnTo");

  return (
    <div className="with-appbar">
      <AppBar />
      <div className="auth-layout">
        <main className="auth-main" id="main-content">
          <div className="auth-main__alternate">
            <LanguageSwitcher />
          </div>
          <div className="auth-panel">
            <div className="auth-panel__heading">
              <h1>{t("login.title")}</h1>
              <p>{t("login.description")}</p>
            </div>
            {error ? (
              <div className="auth-form__error" role="alert">
                {t(isErrorCode(error) ? `error.${error}` : "error.login_failed")}
              </div>
            ) : null}
            <div className="auth-form">
              <a className="ui-button ui-button--primary auth-form__submit" href={loginHref(returnTo)}>
                <SignIn aria-hidden="true" size={20} />
                <span>{t("login.withYourSpace")}</span>
              </a>
              <p className="ui-field__hint">{t("login.registrationHint")}</p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
