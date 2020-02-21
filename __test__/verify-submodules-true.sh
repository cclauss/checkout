  
#!/bin/bash

if [ ! -f "./submodules-true/regular-file.txt" ]; then
    echo "Expected regular file does not exist"
    exit 1
fi

if [ ! -f "./submodules-true/submodule-level-1/submodule-file.txt" ]; then
    echo "Expected submodule file does not exist"
    exit 1
fi

if [ -f "./submodules-true/submodule-level-1/submodule-level-2/nested-submodule-file.txt" ]; then
    echo "Unexpected nested submodule file exists"
    exit 1
fi