import keyring
import re
import pathlib

env = pathlib.Path('.env').read_text()

keys = {
    'DEEPSEEK_API_KEY': 'deepseek_api_key',
    'GROQ_API_KEY': 'groq_api_key',
}

for env_var, keychain_name in keys.items():
    m = re.search(rf'^{env_var}=["\']?([^"\'\ \n]+)', env, re.MULTILINE)
    if m:
        keyring.set_password('ogacode', keychain_name, m.group(1))
        print('Saved:', keychain_name)
    else:
        print('Not found in .env:', env_var)

print('Done. You can delete import_keys.py now.')
