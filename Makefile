# only include .env if it exists
ifneq ($(wildcard .env),)
include .env
endif
fmt:
	pnpm fmt

build:
	pnpm build


fetcher:
	pnpm run dev-fetcher

ui:
	pnpm run dev-ui