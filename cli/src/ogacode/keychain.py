import keyring
import keyring.errors

_SERVICE = "ogacode"


def get_api_key(name: str) -> str | None:
    """Retrieve an API key from the system keyring.

    Args:
        name: The name/identifier of the API key to retrieve.

    Returns:
        The stored API key as a string, or None if no key exists for the given name.
    """
    return keyring.get_password(_SERVICE, name)


def set_api_key(name: str, value: str) -> None:
    """Store an API key in the system keyring.

    Args:
        name: The name/identifier under which to store the key.
        value: The API key value to store.
    """
    keyring.set_password(_SERVICE, name, value)


def delete_api_key(name: str) -> None:
    """Delete an API key from the system keyring.

    Silently ignores the case where the key does not exist.

    Args:
        name: The name/identifier of the API key to delete.
    """
    try:
        keyring.delete_password(_SERVICE, name)
    except keyring.errors.PasswordDeleteError:
        pass
