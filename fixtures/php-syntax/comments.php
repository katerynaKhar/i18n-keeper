<?php
// leading line comment
# hash comment

/* block
   comment */
return [ // after the bracket
    'a' => 'one', // trailing
    # hash before a key
    'b' => /* between key and value */ 'two',
    /* before the close */
];
// after the statement
