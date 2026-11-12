cmake_minimum_required(VERSION 3.25)

project(konstit_csv_parser LANGUAGES C CXX)

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

if(NOT CMAKE_CXX_COMPILER_ID MATCHES "^(AppleClang|Clang)$")
  message(FATAL_ERROR "konstit_csv_parser supports Clang and AppleClang only")
endif()

set(CSV_NATIVE_ARCH "" CACHE STRING "Native target architecture (x86_64 or arm64)")
set_property(CACHE CSV_NATIVE_ARCH PROPERTY STRINGS x86_64 arm64)
option(CSV_NATIVE_SANITIZERS "Build native targets with sanitizers" OFF)
set(CSV_NATIVE_SANITIZER_LIST "address,undefined" CACHE STRING "Comma-separated sanitizer list for native sanitizer builds")
option(CSV_NATIVE_PGO_INSTRUMENT "Build native targets with Clang IR-PGO instrumentation" OFF)
set(CSV_NATIVE_PGO_PROFILE "" CACHE FILEPATH "Clang IR-PGO .profdata file used to optimize native targets")

if(CSV_NATIVE_PGO_INSTRUMENT AND NOT CSV_NATIVE_PGO_PROFILE STREQUAL "")
  message(FATAL_ERROR "CSV_NATIVE_PGO_INSTRUMENT and CSV_NATIVE_PGO_PROFILE are mutually exclusive")
endif()

if(CSV_NATIVE_SANITIZERS AND (CSV_NATIVE_PGO_INSTRUMENT OR NOT CSV_NATIVE_PGO_PROFILE STREQUAL ""))
  message(FATAL_ERROR "Native sanitizers cannot be combined with PGO instrumentation or profile use")
endif()

if(NOT CSV_NATIVE_PGO_PROFILE STREQUAL "" AND NOT EXISTS "${CSV_NATIVE_PGO_PROFILE}")
  message(FATAL_ERROR "CSV_NATIVE_PGO_PROFILE does not exist: ${CSV_NATIVE_PGO_PROFILE}")
endif()

if(CSV_NATIVE_ARCH STREQUAL "")
  if(CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64|x86_64)$")
    set(CSV_NATIVE_ARCH "${CMAKE_OSX_ARCHITECTURES}")
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64)$")
    set(CSV_NATIVE_ARCH "arm64")
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(x86_64|amd64|AMD64)$")
    set(CSV_NATIVE_ARCH "x86_64")
  else()
    message(FATAL_ERROR "Unsupported native architecture: ${CMAKE_SYSTEM_PROCESSOR}")
  endif()
endif()

if(CSV_NATIVE_ARCH STREQUAL "x86_64")
  set(CSV_NATIVE_CPU_FLAGS -mavx2)
elseif(CSV_NATIVE_ARCH STREQUAL "arm64")
  set(CSV_NATIVE_CPU_FLAGS -march=armv8-a+simd)
else()
  message(FATAL_ERROR "CSV_NATIVE_ARCH must be x86_64 or arm64, got: ${CSV_NATIVE_ARCH}")
endif()

# Enable CTest before adding dependencies so CMake regenerates their test files
# when a build reuses FetchContent directories with older test registrations.
include(CTest)
include(FetchContent)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(ABSL_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)
set(HWY_ENABLE_CONTRIB OFF CACHE BOOL "" FORCE)
set(HWY_ENABLE_EXAMPLES OFF CACHE BOOL "" FORCE)
set(HWY_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(HWY_ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(ZLIB_COMPAT OFF CACHE BOOL "" FORCE)
set(ZLIB_ALIASES OFF CACHE BOOL "" FORCE)
set(WITH_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(WITH_BENCHMARK_APPS OFF CACHE BOOL "" FORCE)
set(WITH_FUZZERS OFF CACHE BOOL "" FORCE)
set(WITH_GTEST OFF CACHE BOOL "" FORCE)
set(WITH_GZFILEOP OFF CACHE BOOL "" FORCE)
set(WITH_NATIVE_INSTRUCTIONS ON CACHE BOOL "" FORCE)
set(RE2_BENCHMARK OFF CACHE BOOL "" FORCE)
set(RE2_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(RE2_INSTALL OFF CACHE BOOL "" FORCE)
set(RE2_TEST OFF CACHE BOOL "" FORCE)
if(CSV_NATIVE_ARCH STREQUAL "x86_64")
  set(NATIVE_ARCH_OVERRIDE "-mavx2" CACHE STRING "" FORCE)
else()
  set(NATIVE_ARCH_OVERRIDE "-march=armv8-a+crc+simd" CACHE STRING "" FORCE)
endif()

FetchContent_Declare(
  abseil
  GIT_REPOSITORY https://github.com/abseil/abseil-cpp.git
  GIT_TAG d38452e1ee03523a208362186fd42248ff2609f6 # 20250814.1
  GIT_SHALLOW FALSE
  EXCLUDE_FROM_ALL
  SYSTEM
)
FetchContent_Declare(
  highway
  GIT_REPOSITORY https://github.com/google/highway.git
  GIT_TAG 2607d3b5b0113992fe84d3848859eae13b3b52c1 # 1.4.0
  GIT_SHALLOW FALSE
  EXCLUDE_FROM_ALL
  SYSTEM
)
FetchContent_Declare(
  re2
  GIT_REPOSITORY https://github.com/google/re2.git
  GIT_TAG 927f5d53caf8111721e734cf24724686bb745f55 # 2025-11-05
  GIT_SHALLOW FALSE
  EXCLUDE_FROM_ALL
  SYSTEM
)
FetchContent_Declare(
  unordered_dense
  GIT_REPOSITORY https://github.com/martinus/unordered_dense.git
  GIT_TAG 3234af2c03549bc85656bfd3a86993bf1cd8aef1 # v4.8.1
  GIT_SHALLOW FALSE
  EXCLUDE_FROM_ALL
  SYSTEM
)
FetchContent_Declare(
  zlib_ng
  GIT_REPOSITORY https://github.com/zlib-ng/zlib-ng.git
  GIT_TAG 12731092979c6d07f42da27da673a9f6c7b13586 # 2.3.3
  GIT_SHALLOW FALSE
  EXCLUDE_FROM_ALL
  SYSTEM
)
FetchContent_MakeAvailable(abseil highway re2 unordered_dense)

add_library(csv_native SHARED
  native/csv_parser.cpp
  native/file_probe.cpp
  native/runtime.cpp
  native/zip_reader.cpp
)

target_compile_features(csv_native PRIVATE cxx_std_20)

set(CSV_NATIVE_OPTIMIZED_FLAGS -O3 -DNDEBUG -fomit-frame-pointer -funroll-loops)
set(CSV_NATIVE_SANITIZER_FLAGS -O1 -g -fno-omit-frame-pointer -fsanitize=${CSV_NATIVE_SANITIZER_LIST} -fno-sanitize-recover=all)

function(csv_native_target_options target)
  target_compile_options(${target} PRIVATE
    -Wall
    -Wextra
    -Wpedantic
    ${CSV_NATIVE_CPU_FLAGS}
  )

  if(CSV_NATIVE_SANITIZERS)
    target_compile_options(${target} PRIVATE ${CSV_NATIVE_SANITIZER_FLAGS})
    target_link_options(${target} PRIVATE -fsanitize=${CSV_NATIVE_SANITIZER_LIST})
  else()
    target_compile_options(${target} PRIVATE ${CSV_NATIVE_OPTIMIZED_FLAGS})
  endif()

  if(CSV_NATIVE_PGO_INSTRUMENT)
    target_compile_options(${target} PRIVATE -fprofile-instr-generate)
    target_link_options(${target} PRIVATE -fprofile-instr-generate)
  elseif(NOT CSV_NATIVE_PGO_PROFILE STREQUAL "")
    target_compile_options(${target} PRIVATE "-fprofile-instr-use=${CSV_NATIVE_PGO_PROFILE}")
    target_link_options(${target} PRIVATE "-fprofile-instr-use=${CSV_NATIVE_PGO_PROFILE}")
  endif()
endfunction()

csv_native_target_options(csv_native)
target_compile_options(csv_native PRIVATE -fno-exceptions -fno-rtti)
target_link_options(csv_native PRIVATE -fno-exceptions -fno-rtti)
find_package(Threads REQUIRED)
target_link_libraries(csv_native PRIVATE hwy re2::re2 unordered_dense::unordered_dense Threads::Threads)
if(APPLE AND CSV_NATIVE_ARCH STREQUAL "arm64")
  target_compile_definitions(csv_native PRIVATE CSV_USE_APPLE_ZLIB)
  target_link_libraries(csv_native PRIVATE z)
else()
  set(CSV_NATIVE_BUILD_TESTING "${BUILD_TESTING}")
  set(BUILD_TESTING OFF)
  FetchContent_MakeAvailable(zlib_ng)
  set(BUILD_TESTING "${CSV_NATIVE_BUILD_TESTING}")
  set_target_properties(zlib-ng PROPERTIES C_VISIBILITY_PRESET hidden)
  target_link_libraries(csv_native PRIVATE zlib-ng::zlibstatic)
endif()

set_target_properties(csv_native PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  POSITION_INDEPENDENT_CODE ON
  INTERPROCEDURAL_OPTIMIZATION_RELEASE ON
)

add_executable(csv_native_bench
  native/native_bench.cpp
)

target_compile_features(csv_native_bench PRIVATE cxx_std_20)
target_include_directories(csv_native_bench SYSTEM PRIVATE
  native
)
csv_native_target_options(csv_native_bench)
target_compile_options(csv_native_bench PRIVATE -fno-rtti)
target_link_options(csv_native_bench PRIVATE -fno-rtti)
target_link_libraries(csv_native_bench PRIVATE csv_native)
set_target_properties(csv_native_bench PROPERTIES
  INTERPROCEDURAL_OPTIMIZATION_RELEASE ON
)

if(BUILD_TESTING)
  set(CATCH_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(CATCH_BUILD_EXTRA_TESTS OFF CACHE BOOL "" FORCE)
  set(CATCH_BUILD_TESTING OFF CACHE BOOL "" FORCE)
  set(CATCH_INSTALL_DOCS OFF CACHE BOOL "" FORCE)
  set(CATCH_INSTALL_EXTRAS OFF CACHE BOOL "" FORCE)

  FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG 191fa38c9b1596cd2576ab531d4ab4d5e8e05190 # v3.15.2
    GIT_SHALLOW FALSE
    EXCLUDE_FROM_ALL
    SYSTEM
  )
  FetchContent_MakeAvailable(Catch2)

  add_executable(csv_native_tests
    native/native_csv_cxx_test.cpp
  )

  target_compile_features(csv_native_tests PRIVATE cxx_std_20)
  csv_native_target_options(csv_native_tests)
  target_link_libraries(csv_native_tests PRIVATE csv_native Catch2::Catch2WithMain)

  add_test(NAME csv_native_tests COMMAND csv_native_tests)

  add_executable(csv_native_fuzz
    native/native_csv_fuzz.cpp
  )

  target_compile_features(csv_native_fuzz PRIVATE cxx_std_20)
  csv_native_target_options(csv_native_fuzz)
  target_link_libraries(csv_native_fuzz PRIVATE csv_native)

  add_test(NAME csv_native_fuzz COMMAND csv_native_fuzz)
endif()
