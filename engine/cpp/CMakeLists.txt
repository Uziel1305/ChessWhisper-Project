cmake_minimum_required(VERSION 3.16)
project(chesswhisper_engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Directory-scoped so it reaches every target below. Must come before the
# targets are declared.
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    add_compile_options(-fsanitize=address,undefined -g)
    add_link_options(-fsanitize=address,undefined)
endif()


add_library(engine_core STATIC
    src/board.cpp
    src/eval.cpp
    src/search.cpp
)
target_include_directories(engine_core PUBLIC third_party src)

# Static C++ runtime: the build stage compiles with GCC 13 but the runtime image
# ships Debian bookworm's older libstdc++, and a dynamically-linked binary dies
# at startup on a missing GLIBCXX.
add_executable(chesswhisper_engine src/main.cpp)
target_link_libraries(chesswhisper_engine PRIVATE engine_core)
target_link_options(chesswhisper_engine PRIVATE -static-libstdc++ -static-libgcc)
enable_testing()
add_executable(perft_test tests/perft_test.cpp)
target_link_libraries(perft_test PRIVATE engine_core)
add_test(NAME perft COMMAND perft_test)

