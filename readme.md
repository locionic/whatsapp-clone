### Installation for dev vesion

1. First create a virtual machine with python

> python3 -m venv venv

2. Activate the environment

> source venv/bin/activate

3. Install required dependencies

> pip3 install -r requirements.txt

4. Cd into django folder and apply migrations

> cd djchat && python manage.py migrate

5. Run django backend

> python manage.py runserver

6. Open a new terminal and cd into frontend folder

> cd djchat/frontend

7. Install required modules

> npm i

8. Finally run frontend dev mode

> npm run serve


### Features
* Login and register forms
* Send, receive, accept and reject invitations from another users
* Profile with personal editable tagline
* Emoticons supported
