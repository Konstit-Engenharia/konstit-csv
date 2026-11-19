#pragma once

#ifdef CSV_USE_APPLE_ZLIB
#include <zlib.h>
using csv_zlib_stream = z_stream;
#define CSV_ZLIB(name) name
#else
#include <zlib-ng.h>
using csv_zlib_stream = zng_stream;
#define CSV_ZLIB(name) zng_##name
#endif
