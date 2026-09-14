cmake_minimum_required(VERSION 3.16)
project(chesswhisper_engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(chesswhisper_engine
    src/main.cpp
)
target_include_directories(chesswhisper_engine PRIVATE third_party)
# The build stage compiles with GCC 13, but the runtime image ships Debian
# bookworm's older libstdc++ (GCC 12). A dynamically-linked binary dies at
# startup on a missing GLIBCXX_3.4.32, so link the C++ runtime in statically
# and let the binary stand on its own regardless of the base image.
target_link_options(chesswhisper_engine PRIVATE -static-libstdc++ -static-libgcc)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(chesswhisper_engine PRIVATE -fsanitize=address,undefined -g)
    target_link_options(chesswhisper_engine PRIVATE -fsanitize=address,undefined)
endif()
