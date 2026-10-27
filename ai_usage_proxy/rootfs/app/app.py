"""One Ingress application and MQTT publisher for independent AI usage providers."""

import logging
import signal
import threading

from config import data_directory, load_options
from mqtt_publisher import MqttPublisher
from providers import create_providers
from service import UsageService
from storage import private_directory
from web import make_server

LOG = logging.getLogger("ai_usage_proxy")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    root = private_directory(data_directory())
    options = load_options(root)
    service = UsageService(create_providers(root), options["poll_interval"])
    publisher = MqttPublisher(options, root, service.action)
    service.listeners.append(lambda key: publisher.publish_provider(service.view(key)))
    server = make_server(service, publisher)
    shutdown = threading.Event()

    def stop(signum: int, frame: object) -> None:
        shutdown.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    service.start()
    web_thread = threading.Thread(
        target=server.serve_forever, daemon=True, name="ingress"
    )
    mqtt_thread = threading.Thread(target=publisher.run, daemon=True, name="mqtt")
    web_thread.start()
    mqtt_thread.start()
    LOG.info("AI Usage Proxy listening on Ingress port 8237")
    try:
        shutdown.wait()
    finally:
        server.shutdown()
        server.server_close()
        service.close()
        publisher.close()
        web_thread.join(timeout=3)
        mqtt_thread.join(timeout=3)


if __name__ == "__main__":
    main()
