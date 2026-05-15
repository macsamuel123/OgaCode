import keyring
import keyring.errors

_SERVICE = "ogacode"


def get_api_key(name: str) -> str | None:
    return keyring.get_password(_SERVICE, name)


def set_api_key(name: str, value: str) -> None:
    keyring.set_password(_SERVICE, name, value)


def delete_api_key(name: str) -> None:
    try:
        keyring.delete_password(_SERVICE, name)
    except keyring.errors.PasswordDeleteError:
        pass
