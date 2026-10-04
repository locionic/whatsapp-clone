
# Api tests TODO

# que pueda devolver los mensajes pendientes pero no los no pendientes

# que no pueda ver mensajes de otras personas (que no le corresponde)

# que solo pueda ver los fields que se esperan, y no adicionales o menos de esos

# validaciones varias

# que al crear un mensaje se pueda ver en la sgte llamada a mensajes pendientes pero
# no en la subsiguiente


# mensajes recientes por sala

# verificar que llegan efectivametne los 10 mas recientes por sala

# verificar que efectivamente el orden sea el correcto

# verificar que el usuario no puede preguntar por una sala a la que no pertenece

# verificar que isOwner sea true para cuando el autor esta testeando y false en caso contrario


# Traer mensajes recientes por sala

# probar que si no hay parametro offset entonces se traigan los ultimos 10 por tiempo

# si hay offset entonces los 10 seguientes a partir de el id entregado

# autenticación


# Mesajes recientes

# verificar que efectivamente vengan users y rooms correctos


# Order

# Verificar que efecticamente los mensajes vengan en orden descendente

# Verificar que al offsetear vengan en orden descendente


# read

# verficiar que al crear un mensaje este se marque inicialmente como unread
# para todos los de la sala

# verificar que llegan los mensajes de las distintas salas como unread

# Verificar que efectivametne puedo marcar un mensaje como leido y que despues no llega
# en la lista

# Verificar que no puedo marcar mensajes de otras personas como leido

# verificar que al marcar como leido devuelva 204 no content

# verificar que devuelva toda la lista de no leidos

# verificar que si tomo uno de esa lista puedo marcar como leido
# pero si tomo uno fuera de esa lista entonces no


# All received and all read

# Done -- test_message_pending.py. The announcement waits for the last pending
# participant, and asking a second time announces nothing. Both guards in
# chat/models.py can be deleted with nothing else in the project noticing, which
# was true until that file existed.
