"""用 paramiko 起一个本地 SSH 服务端，把算法锁死成「非 AEAD 加密 + ETM MAC」。

为什么需要它：本项目能拿到的真服务器（用户的机器）加密算法全是 AES-GCM ——
AEAD 路径下 MAC 一律置 none，ETM 根本不会被触发，所以拿它验证不了 ETM。
paramiko 是**独立实现**，用它做对端才有意义（自己对自己写往返测试证明不了互通）。

跑法：python etm_server.py  → 监听 127.0.0.1:2222
"""
import logging
import os
import socket
import sys
import threading
import time
import traceback

import paramiko
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from paramiko import Ed25519Key, ServerInterface, Transport

HOST = "127.0.0.1"
PORT = int(os.environ.get("ETM_PORT", "2222"))

# 只留一个非 AEAD 加密 + 一个 etm MAC：谈成什么都由不得协商。
FORCED_CIPHERS = ("aes128-ctr",)
FORCED_MACS = ("hmac-sha2-256-etm@openssh.com",)

HOSTKEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "etm_hostkey")


def ensure_host_key() -> Ed25519Key:
    if not os.path.exists(HOSTKEY_PATH):
        key = ed25519.Ed25519PrivateKey.generate()
        blob = key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.OpenSSH,
            encryption_algorithm=serialization.NoEncryption(),
        )
        with open(HOSTKEY_PATH, "wb") as handle:
            handle.write(blob)
    return Ed25519Key(filename=HOSTKEY_PATH)


class Handler(ServerInterface):
    """够我们用就行：认任何公钥/密码，exec 请求回一段可预测的输出。"""

    def __init__(self) -> None:
        self.username = "unknown"

    def check_auth_publickey(self, username, key):
        self.username = username
        return paramiko.AUTH_SUCCESSFUL

    def check_auth_password(self, username, password):
        self.username = username
        return paramiko.AUTH_SUCCESSFUL

    def get_allowed_auths(self, username):
        return "publickey,password"

    def check_channel_request(self, kind, chanid):
        return paramiko.OPEN_SUCCEEDED

    def check_channel_pty_request(self, channel, term, width, height, pixelwidth, pixelheight, modes):
        return True

    def check_channel_shell_request(self, channel):
        threading.Thread(target=self._respond, args=(channel, "shell"), daemon=True).start()
        return True

    def check_channel_exec_request(self, channel, command):
        text = command.decode("utf-8", "replace")
        threading.Thread(target=self._respond, args=(channel, text), daemon=True).start()
        return True

    def _respond(self, channel, command: str) -> None:
        # 等一小会儿：paramiko 是在本回调返回之后才发 CHANNEL_SUCCESS 的，
        # 这会儿就写数据会跑到应答前面去。
        time.sleep(0.1)
        try:
            if command == "shell":
                channel.sendall(b"etm-interop-shell\r\n")
            elif "interop-ok" in command:
                channel.sendall(("interop-ok\n%s\n" % self.username).encode())
            elif command.startswith("echo "):
                channel.sendall((command[5:] + "\n").encode())
            else:
                channel.sendall((command + "\n").encode())
            channel.send_exit_status(0)
        except Exception:
            traceback.print_exc()
        finally:
            channel.close()


def serve_one(sock: socket.socket, host_key: Ed25519Key) -> None:
    transport = Transport(sock)
    transport.add_server_key(host_key)
    options = transport.get_security_options()
    # KEX 不限制：它跟 ETM 无关，而且 paramiko 的 SecurityOptions 对 KEX 名字校验很严。
    # 唯一必须锁死的是「非 AEAD 加密 + etm MAC」这两项。
    options.ciphers = FORCED_CIPHERS
    if hasattr(options, "macs"):
        options.macs = FORCED_MACS
    transport.start_server(server=Handler())

    # 协商结果就是验证凭据：候选里只有 etm 一个 MAC，谈成了就说明走的是 ETM。
    print(
        "[server] 协商结果 kex=%s hostkey=%s cipher(local=%s remote=%s) mac(local=%s remote=%s)"
        % (
            getattr(transport, "kex_alg", "?"),
            getattr(transport, "host_key_type", "?"),
            getattr(transport, "local_cipher", "?"),
            getattr(transport, "remote_cipher", "?"),
            getattr(transport, "local_mac", "?"),
            getattr(transport, "remote_mac", "?"),
        ),
        flush=True,
    )

    # 不调 accept()：通道请求由 ServerInterface 的回调直接处理，我们可以开多条通道
    # （第二个用例要在同一个连接上连发三条命令），这里只等对端收工。
    try:
        while transport.is_active():
            time.sleep(0.2)
    except Exception:
        pass
    transport.close()
    print("[server] 连接结束", flush=True)


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    # macs 在 SecurityOptions 上不一定暴露，改类属性也能生效（协商时读的就是它）。
    Transport._preferred_macs = FORCED_MACS
    Transport._preferred_ciphers = FORCED_CIPHERS

    host_key = ensure_host_key()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((HOST, PORT))
    listener.listen(8)
    print("[server] 监听 %s:%d（加密算法=%s, MAC=%s）" % (HOST, PORT, FORCED_CIPHERS[0], FORCED_MACS[0]), flush=True)

    while True:
        try:
            sock, addr = listener.accept()
            print("[server] 连接来自 %s" % (addr,), flush=True)
            threading.Thread(target=serve_one, args=(sock, host_key), daemon=True).start()
        except KeyboardInterrupt:
            break
        except Exception:
            traceback.print_exc()


if __name__ == "__main__":
    main()
