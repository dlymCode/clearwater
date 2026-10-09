# Clearwater pipeline. Run from pipeline/:  make skagit   |   make test
#
# `make <aoi>` runs fetch -> LAZ rasterize -> MLLW -> align -> per-source meta -> waterline
# -> merge -> validate (Gate 1) -> tiles -> publish for ONE AOI, so a bad delta rebuild never
# touches the others. Every step reads and writes files under $(DATA)/<aoi>/<step>/ and is
# safe to rerun. Individual steps: `make AOI=skagit step-merge`.

AOIS := skagit port_susan snohomish padilla_samish nisqually

PY      ?= python3
ROOT    := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
DATA    ?= $(ROOT)/data
# Ground-truth sounder runs for Gate 1: CSVs of time,lat,lon,depth,speed in $(DATA)/ground_truth/<aoi>/
RUNS    ?= $(wildcard $(DATA)/ground_truth/$(AOI)/*.csv)
# VDatum NAVD88->MLLW grid (manual download). Required by step-mllw for NAVD88 rasters.
GTX     ?=
# ENC COALNE GeoJSON for the MANDATORY shoreline datum check (produced by the tiles vector stage)
COALNE  ?= $(wildcard $(DATA)/$(AOI)/tiles/enc_geojson/*_COALNE.geojson)
PUBLISH_FLAGS ?=
# Dev-only overrides for validate: --skip-waterline-gate --skip-shoreline-check (never for a real publish)
VALIDATE_FLAGS ?=

PYRUN = cd $(ROOT) && $(PY) -m

.PHONY: all test lint tides schema-check $(AOIS) run-aoi need-aoi \
        step-fetch step-laz step-mllw step-align step-meta step-waterline step-merge step-validate step-tiles step-publish
.NOTPARALLEL:

all: $(AOIS)

$(AOIS):
	$(MAKE) AOI=$@ run-aoi

run-aoi: step-fetch step-laz step-mllw step-align step-meta step-waterline step-merge step-tiles step-validate step-publish

need-aoi:
	@test -n "$(AOI)" || (echo "set AOI=<one of: $(AOIS)>" && exit 2)

step-fetch: need-aoi
	$(PYRUN) pipeline.fetch_baseline --aoi $(AOI) --data-dir $(DATA)

step-laz: need-aoi
	$(PYRUN) pipeline.align --aoi $(AOI) --data-dir $(DATA) --stage laz

step-mllw: need-aoi
	$(PYRUN) pipeline.to_mllw --aoi $(AOI) --data-dir $(DATA) $(if $(GTX),--gtx $(GTX),)

step-align: need-aoi
	$(PYRUN) pipeline.align --aoi $(AOI) --data-dir $(DATA) --stage warp

step-meta: need-aoi
	$(PYRUN) pipeline.source_meta --aoi $(AOI) --data-dir $(DATA)

step-waterline: need-aoi
	$(PYRUN) pipeline.waterline_dem --aoi $(AOI) --data-dir $(DATA)

step-merge: need-aoi
	$(PYRUN) pipeline.merge --aoi $(AOI) --data-dir $(DATA)

# Gate 1: exits non-zero (and stops the pipeline before publish) if waterline p90 > 1.5 ft.
# Runs after step-tiles only because the shoreline datum check needs the ENC COALNE GeoJSON that
# the tiles vector stage produces; nothing is uploaded until step-publish, which comes last.
step-validate: need-aoi
	@test $(words $(RUNS)) -ge 3 || (echo "need >= 3 ground-truth CSVs in $(DATA)/ground_truth/$(AOI)/ (or pass RUNS=...), found $(words $(RUNS)); refusing to publish unvalidated tiles" && exit 2)
	$(PYRUN) pipeline.validate --aoi $(AOI) --data-dir $(DATA) --runs $(RUNS) --coalne $(COALNE) $(VALIDATE_FLAGS)

step-tiles: need-aoi
	$(PYRUN) pipeline.tiles --aoi $(AOI) --data-dir $(DATA) --stage all

step-publish: need-aoi
	$(PYRUN) pipeline.publish --aoi $(AOI) --data-dir $(DATA) $(PUBLISH_FLAGS)

# Daily: 30 days of tide predictions, one JSON per station
tides:
	$(PYRUN) pipeline.fetch_tides --out $(DATA)/tides

schema-check:
	cd $(ROOT)/pipeline && $(PY) -m jsonschema -i tests/fixtures/tiles_index.example.json schemas/tiles_index.schema.json

test:
	cd $(ROOT) && $(PY) -m pytest pipeline/tests -q

lint:
	cd $(ROOT)/pipeline && ruff check .
