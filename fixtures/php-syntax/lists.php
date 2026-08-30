<?php

return [
    'sequential' => ['a', 'b', 'c'],
    'nested_list' => [['x', 'y'], ['z']],
    'mixed' => [
        'named' => 'value',
        'list' => [1, 2, 3],
    ],
    'deep' => [
        'one' => [
            'two' => [
                'three' => 'bottom',
            ],
        ],
    ],
    'trailing_comma' => ['a', 'b',],
    'empty_array' => [],
    'legacy' => array('k' => array('nested' => 'v')),
];
