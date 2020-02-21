#!/bin/bash

if [ ! -f "./submodules-recursive/regular-file.txt" ]; then
    echo "Expected regular file does not exist"
    exit 1
fi

if [ ! -f "./submodules-recursive/submodule-level-1/submodule-file.txt" ]; then
    echo "Expected submodule file does not exist"
    exit 1
fi

if [ ! -f "./submodules-recursive/submodule-level-1/submodule-level-2/nested-submodule-file.txt" ]; then
    echo "Expected nested submodule file does not exists"
    exit 1
fi