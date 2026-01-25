"""YSB MT5 optional worker.

Runs on Windows with MetaTrader5 terminal installed.
Expose POST /mt5/login and validate credentials via MetaTrader5 package.
"""

import os
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="YSB MT5 Worker", version="0.1.0")

API_KEY = os.getenv("MT5_WORKER_API_KEY", "change-me")


class LoginReq(BaseModel):
    server: str
    login: str
    password: str


@app.post("/mt5/login")
def mt5_login(req: LoginReq, x_api_key: str = Header(default="")):
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")

    try:
        import MetaTrader5 as mt5  # type: ignore
    except Exception as e:
        return {"ok": False, "message": f"MetaTrader5 not available: {e}"}

    if not mt5.initialize():
        return {"ok": False, "message": "mt5.initialize failed"}

    try:
        ok = mt5.login(int(req.login), password=req.password, server=req.server)
        if not ok:
            return {"ok": False, "message": "mt5.login failed"}

        info = mt5.account_info()
        account_info = info._asdict() if info else {}
        return {"ok": True, "account_info": account_info}
    finally:
        mt5.shutdown()
