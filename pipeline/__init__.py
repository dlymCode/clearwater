"""Clearwater (Sound Maps) batch data pipeline.

Run steps as modules from the repo root, e.g. ``python -m pipeline.merge --aoi skagit``.
Core logic is pure numpy; rasterio/gdal/pdal/pyproj/pystac imports are lazy.
"""
