# CloudCLI UI — Docker compose helper
# Point at the custom root compose.yaml (the official docker/ templates are separate).
COMPOSE ?= docker compose -f compose.yaml

.PHONY: up down build clean logs ps

## up: build (if needed) and start the container in the background
up:
	$(COMPOSE) up -d --build

## down: stop the container (keeps the data volume)
down:
	$(COMPOSE) down

## build: build the image without starting
build:
	$(COMPOSE) build

## clean: stop, remove the container, its local image and the data volume
clean:
	$(COMPOSE) down --rmi local --volumes

## logs: tail the container logs
logs:
	$(COMPOSE) logs -f

## ps: show running services
ps:
	$(COMPOSE) ps
