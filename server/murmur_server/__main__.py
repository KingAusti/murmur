import logging

import uvicorn

from .app import create_app
from .config import HOST, PORT

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
uvicorn.run(create_app(), host=HOST, port=PORT, log_level="info", access_log=False)
